import { env } from "../config/env.js";

export async function sendVerificationEmail(toEmail, verifyUrl) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": env.brevoApiKey
    },
    body: JSON.stringify({
      sender: { name: env.brevoSenderName, email: env.brevoSenderEmail },
      to: [{ email: toEmail }],
      subject: "Verify your WwaBot account",
      htmlContent: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#09090f;font-family:Inter,system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#09090f;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#111121;border:1px solid rgba(255,255,255,0.07);border-radius:16px;overflow:hidden;">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#a855f7,#ec4899);padding:24px;text-align:center;">
            <span style="font-size:2rem;">🤖</span>
            <div style="color:white;font-size:1.25rem;font-weight:800;margin-top:8px;">WwaBot</div>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px;color:#f0eeff;">
            <h2 style="margin:0 0 12px;font-size:1.25rem;font-weight:700;">Verify your email address</h2>
            <p style="margin:0 0 24px;color:#8b87b0;line-height:1.7;font-size:0.9375rem;">
              You're almost ready to start deploying WhatsApp bots.
              Click the button below to verify your email and activate your WwaBot account.
            </p>
            <table cellpadding="0" cellspacing="0"><tr><td>
              <a href="${verifyUrl}"
                style="display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:white;
                       text-decoration:none;padding:12px 28px;border-radius:100px;font-weight:700;
                       font-size:0.9375rem;box-shadow:0 0 28px rgba(168,85,247,0.35);">
                Verify my account
              </a>
            </td></tr></table>
            <p style="margin:24px 0 0;font-size:0.8125rem;color:#4e4a6a;">
              Or copy this link into your browser:<br>
              <a href="${verifyUrl}" style="color:#a855f7;word-break:break-all;">${verifyUrl}</a>
            </p>
            <p style="margin:16px 0 0;font-size:0.8125rem;color:#4e4a6a;">
              This link expires in 24 hours. If you didn't create a WwaBot account, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.07);color:#4e4a6a;font-size:0.75rem;">
            © ${new Date().getFullYear()} WwaBot · WhatsApp Bot Platform
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
      `
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Email delivery failed: ${errorText}`);
  }
}
