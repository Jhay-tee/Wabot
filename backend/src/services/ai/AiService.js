/**
 * AiService — lightweight wrapper for AI provider APIs.
 * Pro plan currently supports: OpenAI and Google Gemini.
 */

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/* ── Key encryption/decryption ──────────────────────────────── */

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

export function encryptApiKey(plaintext, secret) {
  const key = deriveKey(secret);
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc  = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptApiKey(ciphertext, secret) {
  try {
    const [ivHex, tagHex, dataHex] = ciphertext.split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const key     = deriveKey(secret);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(dataHex, "hex", "utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

/* ── AI completion ──────────────────────────────────────────── */

/**
 * @param {{provider:string, apiKey:string, model:string, systemPrompt:string, userMessage:string}} opts
 * @returns {Promise<string>}
 */
export async function getAiCompletion({ provider, apiKey, model, systemPrompt, userMessage }) {
  const timeout = AbortSignal.timeout(20_000);

  switch (provider) {
    case "openai":
      return callOpenAI({ apiKey, model: model || "gpt-4o-mini", systemPrompt, userMessage, timeout });

    case "gemini":
      return callGemini({ apiKey, model: model || "gemini-1.5-flash", systemPrompt, userMessage, timeout });

    default:
      throw new Error(`Unknown AI provider: ${provider}`);
  }
}

async function callOpenAI({ apiKey, model, systemPrompt, userMessage, timeout, baseUrl }) {
  const url = `${baseUrl ?? "https://api.openai.com"}/v1/chat/completions`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body:    JSON.stringify({
      model,
      messages:   [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
      max_tokens: 500,
      temperature: 0.7
    }),
    signal: timeout
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function callGemini({ apiKey, model, systemPrompt, userMessage, timeout }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents:           [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig:   { maxOutputTokens: 500, temperature: 0.7 }
    }),
    signal: timeout
  });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
}

export const AI_PROVIDERS = [
  {
    id:       "openai",
    name:     "OpenAI",
    models:   ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
    applyUrl: "https://platform.openai.com/api-keys",
    logo:     "🟢"
  },
  {
    id:       "gemini",
    name:     "Google Gemini",
    models:   ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
    applyUrl: "https://aistudio.google.com/apikey",
    logo:     "🔵"
  }
];
