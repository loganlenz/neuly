import axios from 'axios';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Email delivery with a graceful fallback chain:
 * - RESEND_API_KEY set -> send via Resend
 * - otherwise -> write the message to data/outbox/ so nothing is lost
 *   in development and the pipeline stays end-to-end testable.
 */
export class Mailer {
  private outboxDir: string;
  private from: string;

  constructor(options: { outboxDir?: string } = {}) {
    this.outboxDir = options.outboxDir ?? join(process.cwd(), 'data', 'outbox');
    this.from = process.env.MAIL_FROM ?? 'Neuly <alerts@neuly.io>';
  }

  async send(email: OutgoingEmail): Promise<'sent' | 'outbox'> {
    const apiKey = process.env.RESEND_API_KEY;

    if (apiKey) {
      await axios.post(
        'https://api.resend.com/emails',
        { from: this.from, to: [email.to], subject: email.subject, html: email.html, text: email.text },
        { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 30000 }
      );
      logger.info(`[Mailer] Sent "${email.subject}" to ${email.to}`);
      return 'sent';
    }

    mkdirSync(this.outboxDir, { recursive: true });
    const safeTo = email.to.replace(/[^a-z0-9@.\-_]/gi, '_');
    const filename = `${Date.now()}_${safeTo}.html`;
    const header = `<!-- to: ${email.to} | subject: ${email.subject} -->\n`;
    writeFileSync(join(this.outboxDir, filename), header + email.html, 'utf-8');
    logger.info(`[Mailer] RESEND_API_KEY not set — wrote "${email.subject}" for ${email.to} to outbox`);
    return 'outbox';
  }
}
