import nodemailer from 'nodemailer';
import { config } from '../config.js';

/**
 * When SMTP_HOST is unset (local dev), emails are logged to the console instead
 * of being sent, so the forgot-password flow works with zero setup.
 */
let transporter = null;
if (config.smtp.host) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

export async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.log(
      ['', '──────── [mailer:console] ────────', `To:      ${to}`, `Subject: ${subject}`, '', text, '──────────────────────────────────', ''].join('\n'),
    );
    return { mocked: true };
  }
  return transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
}

export function sendPasswordResetEmail(to, resetUrl) {
  const minutes = config.resetTokenTtlMinutes;
  return sendMail({
    to,
    subject: 'Reset your CPQ to RCA password',
    text: `We received a request to reset your password.\n\nReset it here (valid for ${minutes} minutes):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>We received a request to reset your password.</p>
<p><a href="${resetUrl}">Reset your password</a> (valid for ${minutes} minutes).</p>
<p>If you didn't request this, you can ignore this email.</p>`,
  });
}
