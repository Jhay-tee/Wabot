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
      subject: "Verify your Botify account",
      htmlContent: `
        <h2>Welcome to Botify</h2>
        <p>Click the button below to verify your email before deploying bots.</p>
        <p><a href="${verifyUrl}" style="background:#7c3aed;color:white;padding:10px 16px;border-radius:6px;text-decoration:none;">Verify Account</a></p>
        <p>If the button does not work, copy this link:</p>
        <p>${verifyUrl}</p>
      `
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Brevo send failed: ${errorText}`);
  }
}
