import { Router, Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';
import { getAppDb, appDbAvailable } from '../db/appDb.js';
import { AuthedRequest, requireUser, audit, Plan } from '../auth/auth.js';
import { publicPlans } from '../web/plans.js';
import { logger } from '../utils/logger.js';

/**
 * Thin Stripe integration over the REST API, active only when
 * STRIPE_SECRET_KEY is set. Flow:
 * 1. GET  /api/billing/plans -> plan catalog for the pricing page
 * 2. POST /api/billing/checkout {plan} -> Stripe Checkout URL
 * 3. Stripe webhook -> keep users.plan in sync with the subscription
 *    (checkout completed, plan changed in the portal, cancelled, payment failed)
 * 4. POST /api/billing/portal -> customer portal URL for self-service
 *
 * Configure prices via STRIPE_PRICE_PRO / STRIPE_PRICE_ENTERPRISE
 * (price IDs from the Stripe dashboard) and STRIPE_WEBHOOK_SECRET.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

async function stripePost(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await axios.post(`${STRIPE_API}${path}`, new URLSearchParams(form).toString(), {
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: 30000
  });
  return response.data;
}

/**
 * Verify a Stripe webhook signature (v1 scheme) against the raw body.
 * Exported for tests.
 */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, toleranceSeconds = 300, now = Date.now()): boolean {
  if (!header) return false;

  const parts = new Map<string, string[]>();
  for (const element of header.split(',')) {
    const [key, value] = element.split('=', 2);
    if (!key || !value) continue;
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }

  const timestamp = parts.get('t')?.[0];
  const signatures = parts.get('v1') ?? [];
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const expectedBuf = Buffer.from(expected);

  return signatures.some(sig => {
    const sigBuf = Buffer.from(sig);
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
}

function planPrice(plan: string): string | undefined {
  if (plan === 'pro') return process.env.STRIPE_PRICE_PRO;
  if (plan === 'enterprise') return process.env.STRIPE_PRICE_ENTERPRISE;
  return undefined;
}

/** Reverse lookup: which plan does a Stripe price id belong to? Exported for tests. */
export function planForPrice(priceId: string | undefined, env: NodeJS.ProcessEnv = process.env): Plan | undefined {
  if (!priceId) return undefined;
  if (priceId === env.STRIPE_PRICE_PRO) return 'pro';
  if (priceId === env.STRIPE_PRICE_ENTERPRISE) return 'enterprise';
  return undefined;
}

/**
 * Decide the user's plan from a subscription object. Exported for tests.
 * Returns the plan plus a status label stored in users.plan_status.
 */
export function planFromSubscription(subscription: {
  status?: string;
  items?: { data?: Array<{ price?: { id?: string } }> };
  metadata?: { plan?: string };
}, env: NodeJS.ProcessEnv = process.env): { plan: Plan; status: string } {
  const status = subscription.status ?? 'active';
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const fromPrice = planForPrice(priceId, env);
  const fromMeta = subscription.metadata?.plan;
  const paidPlan: Plan | undefined = fromPrice ?? (fromMeta === 'pro' || fromMeta === 'enterprise' ? fromMeta : undefined);

  // Access continues while Stripe retries a failed payment (past_due); it
  // ends when the subscription is cancelled, unpaid or incomplete-expired.
  const keepsAccess = ['active', 'trialing', 'past_due'].includes(status);
  if (!paidPlan || !keepsAccess) return { plan: 'free', status };
  return { plan: paidPlan, status };
}

export function billingRouter(): Router {
  const router = Router();

  // Plan catalog is public: the pricing page renders from it
  router.get('/plans', (_req: Request, res: Response) => {
    res.json({ data: publicPlans(), billingEnabled: stripeConfigured() && appDbAvailable() });
  });

  const requireConfigured = (_req: Request, res: Response, next: NextFunction) => {
    if (!stripeConfigured() || !appDbAvailable()) {
      res.status(503).json({
        error: 'Billing is not configured yet. Set STRIPE_SECRET_KEY, STRIPE_PRICE_PRO, STRIPE_PRICE_ENTERPRISE, STRIPE_WEBHOOK_SECRET and DATABASE_URL.'
      });
      return;
    }
    next();
  };

  router.post('/checkout', requireConfigured, requireUser, async (req: AuthedRequest, res: Response) => {
    const plan = req.body?.plan;
    const price = typeof plan === 'string' ? planPrice(plan) : undefined;
    if (!price) {
      return res.status(400).json({ error: 'plan must be "pro" or "enterprise" (and its Stripe price configured)' });
    }
    if (req.user!.plan === plan) {
      return res.status(400).json({ error: `You are already on the ${plan} plan — manage it from the billing portal` });
    }

    try {
      const existing = await getAppDb().query('SELECT stripe_customer_id FROM users WHERE id = $1', [req.user!.id]);
      const customerId: string | null = existing.rows[0]?.stripe_customer_id ?? null;
      const site = process.env.SITE_URL ?? 'http://localhost:3001';
      const form: Record<string, string> = {
        mode: 'subscription',
        'line_items[0][price]': price,
        'line_items[0][quantity]': '1',
        client_reference_id: req.user!.id,
        'metadata[userId]': req.user!.id,
        'metadata[plan]': plan,
        'subscription_data[metadata][userId]': req.user!.id,
        'subscription_data[metadata][plan]': plan,
        allow_promotion_codes: 'true',
        success_url: `${site}/account?upgraded=${plan}`,
        cancel_url: `${site}/pricing`
      };
      // Reuse the Stripe customer so upgrades keep one billing history
      if (customerId) form.customer = customerId;
      else form.customer_email = req.user!.email;

      const session = await stripePost('/checkout/sessions', form);
      res.json({ url: session.url });
    } catch (error) {
      logger.error(`[billing] checkout failed: ${error instanceof Error ? error.message : error}`);
      res.status(502).json({ error: 'Failed to create checkout session' });
    }
  });

  router.post('/portal', requireConfigured, requireUser, async (req: AuthedRequest, res: Response) => {
    try {
      const result = await getAppDb().query('SELECT stripe_customer_id FROM users WHERE id = $1', [req.user!.id]);
      const customerId = result.rows[0]?.stripe_customer_id;
      if (!customerId) {
        return res.status(400).json({ error: 'No billing profile yet — subscribe first' });
      }

      const session = await stripePost('/billing_portal/sessions', {
        customer: customerId,
        return_url: `${process.env.SITE_URL ?? 'http://localhost:3001'}/account`
      });
      res.json({ url: session.url });
    } catch (error) {
      logger.error(`[billing] portal failed: ${error instanceof Error ? error.message : error}`);
      res.status(502).json({ error: 'Failed to create portal session' });
    }
  });

  return router;
}

/**
 * Webhook handler — mounted with a raw body parser (signature is
 * computed over the exact bytes Stripe sent).
 */
export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !appDbAvailable()) {
    res.status(503).json({ error: 'Billing webhook not configured' });
    return;
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody) || !verifyStripeSignature(rawBody, req.headers['stripe-signature'] as string | undefined, secret)) {
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  try {
    const event = JSON.parse(rawBody.toString('utf8'));
    const type = event?.type as string;
    const object = event?.data?.object ?? {};
    const db = getAppDb();

    if (type === 'checkout.session.completed') {
      const userId = object.client_reference_id || object.metadata?.userId;
      const plan = object.metadata?.plan;
      if (userId && (plan === 'pro' || plan === 'enterprise')) {
        await db.query(
          `UPDATE users SET plan = $1, plan_status = 'active',
             stripe_customer_id = COALESCE($2, stripe_customer_id),
             stripe_subscription_id = COALESCE($3, stripe_subscription_id),
             updated_at = now()
           WHERE id = $4`,
          [plan, object.customer ?? null, typeof object.subscription === 'string' ? object.subscription : null, userId]
        );
        await audit(null, 'billing.checkout_completed', userId, { plan, customer: object.customer });
        logger.info(`[billing] ${userId} upgraded to ${plan}`);
      }
    } else if (type === 'customer.subscription.updated' || type === 'customer.subscription.created') {
      // Plan switched in the portal, trial ended, payment recovered, ...
      const customerId = object.customer;
      if (customerId) {
        const { plan, status } = planFromSubscription(object);
        await db.query(
          `UPDATE users SET plan = $1, plan_status = $2, stripe_subscription_id = $3, updated_at = now()
           WHERE stripe_customer_id = $4`,
          [plan, status, object.id ?? null, customerId]
        );
        logger.info(`[billing] subscription ${object.id} for ${customerId} -> ${plan} (${status})`);
      }
    } else if (type === 'customer.subscription.deleted') {
      const customerId = object.customer;
      if (customerId) {
        await db.query(
          "UPDATE users SET plan = 'free', plan_status = 'canceled', stripe_subscription_id = NULL, updated_at = now() WHERE stripe_customer_id = $1",
          [customerId]
        );
        await audit(null, 'billing.subscription_deleted', customerId);
        logger.info(`[billing] subscription cancelled for customer ${customerId} — downgraded to free`);
      }
    } else if (type === 'invoice.payment_failed') {
      const customerId = object.customer;
      if (customerId) {
        await db.query(
          "UPDATE users SET plan_status = 'past_due', updated_at = now() WHERE stripe_customer_id = $1", [customerId]);
        logger.warn(`[billing] payment failed for customer ${customerId}`);
      }
    } else if (type === 'invoice.paid') {
      const customerId = object.customer;
      if (customerId) {
        await db.query(
          "UPDATE users SET plan_status = 'active', updated_at = now() WHERE stripe_customer_id = $1 AND plan <> 'free'", [customerId]);
      }
    }

    res.json({ received: true });
  } catch (error) {
    logger.error(`[billing] webhook failed: ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}
