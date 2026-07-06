import nodemailer from "nodemailer";

// SMTP config from env (see .env: EMAIL, EMAIL_PASSWORD, EMAIL_OUTGOING_SERVER,
// EMAIL_OUTGOING_SMTP_PORT). If unset, email is disabled and sends are no-ops.
const EMAIL = process.env.EMAIL || "";
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "";
const SMTP_HOST = process.env.EMAIL_OUTGOING_SERVER || "";
const SMTP_PORT = parseInt(process.env.EMAIL_OUTGOING_SMTP_PORT || "587", 10);
const FROM_NAME = process.env.EMAIL_FROM_NAME || "Open Assistant";

export const emailEnabled = !!(EMAIL && EMAIL_PASSWORD && SMTP_HOST);

let transporter: nodemailer.Transporter | null = null;
function getTransport() {
  if (!emailEnabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 465 = implicit TLS, 587 = STARTTLS
      auth: { user: EMAIL, pass: EMAIL_PASSWORD },
    });
  }
  return transporter;
}

async function send(to: string, subject: string, html: string, text: string) {
  const tx = getTransport();
  if (!tx) {
    console.warn(`[email] disabled — would have sent "${subject}" to ${to}`);
    return false;
  }
  try {
    await tx.sendMail({ from: `"${FROM_NAME}" <${EMAIL}>`, to, subject, text, html });
    return true;
  } catch (err: any) {
    console.error(`[email] failed to send "${subject}" to ${to}:`, err?.message || err);
    return false;
  }
}

function wrap(title: string, body: string, button: { label: string; url: string }) {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;padding:24px">
  <div style="max-width:480px;margin:0 auto;background:#161616;border:1px solid #262626;border-radius:16px;padding:28px">
    <h2 style="margin:0 0 12px;color:#fff">${title}</h2>
    <p style="color:#a3a3a3;line-height:1.6;margin:0 0 20px">${body}</p>
    <a href="${button.url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600">${button.label}</a>
    <p style="color:#737373;font-size:12px;line-height:1.6;margin:20px 0 0">Or paste this link:<br><a href="${button.url}" style="color:#818cf8;word-break:break-all">${button.url}</a></p>
  </div></body></html>`;
}

export async function sendVerificationEmail(to: string, link: string) {
  return send(
    to,
    "Verify your Open Assistant email",
    wrap("Confirm your email", "Click below to verify your email and activate your Open Assistant account. This link expires in 24 hours.", { label: "Verify email", url: link }),
    `Verify your email: ${link}`,
  );
}

export async function sendPasswordResetEmail(to: string, link: string) {
  return send(
    to,
    "Reset your Open Assistant password",
    wrap("Reset your password", "We received a request to reset your password. Click below to choose a new one. This link expires in 1 hour. If you didn't request this, ignore this email.", { label: "Reset password", url: link }),
    `Reset your password: ${link}`,
  );
}
