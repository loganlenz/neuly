import { Router, Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';
import { getAppDb, appDbAvailable } from '../db/appDb.js';
import { AuthedRequest, requireUser } from '../auth/auth.js';
import { logger } from '../utils/logger.js';

/**
 * Thin Stripe integration over the REST API, active only when
 * STRIPE_SECRET_KEY is set. Flow:
 * 1. POST /api/billing/checkout {plan} -> Stripe Checkout URL
 * 2. Stripe webhook (checkout.session.completed) -> set user's plan
 * 3. POST /api/billing/portal -> customer portal URL for self-service
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

export function billingRouter(): Router {
  const router = Router();

  const requireConfigured = (_req: Request, res: Response, next: NextFunction) => {
    if (!stripeConfigured() || !appDbAvailable()) {
      res.status(503).json({
        error: 'Billing is not configured. Set STRIPE_SECRET_KEY, STRIPE_PRICE_PRO, STRIPE_PRICE_ENTERPRISE, STRIPE_WEBHOOK_SECRET and DATABASE_URL.'
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

    try {
      const session = await stripePost('/checkout/sessions', {
        mode: 'subscription',
        'line_items[0][price]': price,
        'line_items[0][quantity]': '1',
        customer_email: req.user!.email,
        client_reference_id: req.user!.id,
        'metadata[userId]': req.user!.id,
        'metadata[plan]': plan,
        success_url: `${process.env.SITE_URL ?? 'http://localhost:3001'}/account?upgraded=1`,
        cancel_url: `${process.env.SITE_URL ?? 'http://localhost:3001'}/account`
      });
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

    if (type === 'checkout.session.completed') {
      const userId = object.client_reference_id || object.metadata?.userId;
      const plan = object.metadata?.plan;
      if (userId && (plan === 'pro' || plan === 'enterprise')) {
        await getAppDb().query(
          'UPDATE users SET plan = $1, stripe_customer_id = COALESCE($2, stripe_customer_id) WHERE id = $3',
          [plan, object.customer ?? null, userId]
        );
        logger.info(`[billing] ${userId} upgraded to ${plan}`);
      }
    } else if (type === 'customer.subscription.deleted') {
      const customerId = object.customer;
      if (customerId) {
        await getAppDb().query(
          "UPDATE users SET plan = 'free' WHERE stripe_customer_id = $1",
          [customerId]
        );
        logger.info(`[billing] subscription cancelled for customer ${customerId} — downgraded to free`);
      }
    }

    res.json({ received: true });
  } catch (error) {
    logger.error(`[billing] webhook failed: ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}
