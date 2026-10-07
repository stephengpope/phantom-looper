// Mailer — the one way this backend sends an email. SMTP through
// nodemailer, so the server's owner brings any provider (Gmail, Fastmail,
// SES, Postmark — anything with an SMTP door) and nothing here names one.
// The six `smtp_*` settings say where and as whom; they are read on every
// send, so a change applies to the next mail with no restart. A failure is
// the provider's words.
import { createTransport } from 'nodemailer';
import type { Settings } from '../storage/Settings.js';
import { logger, errStr } from '../lib/log.js';
import { textOf } from '../lib/text.js';

const log = logger('mail');

export interface Mail { to: string; subject: string; text: string; html?: string }

export class MailerError extends Error {
  constructor(readonly code: 'not_configured' | 'send_failed', message: string) { super(message); this.name = 'MailerError'; }
}

const SMTP_KEYS = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_from'] as const;

export class Mailer {
  constructor(private readonly settings: Settings) {}

  /** Host, port, user, password and from are all set. */
  async configured(): Promise<boolean> {
    const smtp = await this.settings.resolveMany(SMTP_KEYS);
    return Boolean(smtp.smtp_host && smtp.smtp_port && smtp.smtp_user && smtp.smtp_from && await this.settings.credential('smtp_password'));
  }

  /** Send one mail. `not_configured` when an smtp setting is missing;
   *  `send_failed` with the provider's reason otherwise. */
  async send(mail: Mail): Promise<void> {
    const smtp = await this.settings.resolveMany(SMTP_KEYS);
    const password = await this.settings.credential('smtp_password');
    if (!(smtp.smtp_host && smtp.smtp_port && smtp.smtp_user && smtp.smtp_from && password)) {
      throw new MailerError('not_configured', 'mail is not configured: set smtp_host, smtp_port, smtp_user, smtp_password and smtp_from');
    }
    const transport = createTransport({
      host: textOf(smtp.smtp_host), port: Number(smtp.smtp_port), secure: smtp.smtp_secure === true,
      auth: { user: textOf(smtp.smtp_user), pass: password },
    });
    try {
      await transport.sendMail({ from: textOf(smtp.smtp_from), to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
      log.info({ to: mail.to, subject: mail.subject }, 'mail sent');
    } catch (error) {
      log.warn({ to: mail.to, err: errStr(error) }, 'mail failed');
      throw new MailerError('send_failed', errStr(error));
    } finally {
      transport.close();
    }
  }
}
