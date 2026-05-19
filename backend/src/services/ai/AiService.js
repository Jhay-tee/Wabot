/**
 * AiService — unified AI provider abstraction.
 * Supported providers: OpenAI, Google Gemini, Groq
 */

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const AI_TIMEOUT_MS = 25_000;

/* ── Key encryption/decryption ──────────────────────────────── */

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

export function encryptApiKey(plaintext, secret) {
  const key    = deriveKey(secret);
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptApiKey(ciphertext, secret) {
  try {
    const [ivHex, tagHex, dataHex] = ciphertext.split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const key      = deriveKey(secret);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(dataHex, "hex", "utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

/* ── Model registry ─────────────────────────────────────────── */

export const AI_PROVIDERS = [
  {
    id:       "openai",
    name:     "OpenAI",
    logo:     "🟢",
    models:   [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-3.5-turbo"
    ],
    applyUrl: "https://platform.openai.com/api-keys"
  },
  {
    id:       "gemini",
    name:     "Google Gemini",
    logo:     "🔵",
    models:   [
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "gemini-1.5-flash-8b"
    ],
    applyUrl: "https://aistudio.google.com/apikey"
  },
  {
    id:       "groq",
    name:     "Groq",
    logo:     "⚡",
    models:   [
      "llama-3.3-70b-versatile",
      "llama-3.1-70b-versatile",
      "llama-3.1-8b-instant",
      "llama3-70b-8192",
      "llama3-8b-8192",
      "mixtral-8x7b-32768",
      "gemma2-9b-it"
    ],
    applyUrl: "https://console.groq.com/keys"
  }
];

/* ── AI completion dispatcher ───────────────────────────────── */

/**
 * @param {{provider:string, apiKey:string, model:string, systemPrompt:string, userMessage:string}} opts
 * @returns {Promise<string>}
 */
export async function getAiCompletion({ provider, apiKey, model, systemPrompt, userMessage }) {
  const signal = AbortSignal.timeout(AI_TIMEOUT_MS);

  switch (provider?.toLowerCase()) {
    case "openai":
      return callOpenAI({ apiKey, model: model || "gpt-4o-mini", systemPrompt, userMessage, signal });

    case "gemini":
      return callGemini({ apiKey, model: model || "gemini-2.0-flash", systemPrompt, userMessage, signal });

    case "groq":
      return callGroq({ apiKey, model: model || "llama-3.3-70b-versatile", systemPrompt, userMessage, signal });

    default:
      throw new Error(`Unknown AI provider: "${provider}". Supported: openai, gemini, groq`);
  }
}

/**
 * Validate an AI API key by making a minimal test call.
 * @param {{provider:string, apiKey:string}} opts
 * @returns {Promise<{ok:boolean, model?:string, error?:string}>}
 */
export async function testAiKey({ provider, apiKey }) {
  try {
    const signal = AbortSignal.timeout(15_000);
    switch (provider?.toLowerCase()) {
      case "openai": {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { "Authorization": `Bearer ${apiKey}` },
          signal
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { ok: false, error: body?.error?.message || `OpenAI returned ${res.status}` };
        }
        return { ok: true, model: "gpt-4o-mini" };
      }

      case "gemini": {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1`,
          { signal }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { ok: false, error: body?.error?.message || `Gemini returned ${res.status}` };
        }
        return { ok: true, model: "gemini-2.0-flash" };
      }

      case "groq": {
        const res = await fetch("https://api.groq.com/openai/v1/models", {
          headers: { "Authorization": `Bearer ${apiKey}` },
          signal
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { ok: false, error: body?.error?.message || `Groq returned ${res.status}` };
        }
        return { ok: true, model: "llama-3.3-70b-versatile" };
      }

      default:
        return { ok: false, error: `Unknown provider: ${provider}` };
    }
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { ok: false, error: "Connection timed out — check the API key and try again." };
    }
    return { ok: false, error: err.message || "Unknown error" };
  }
}

/* ── Provider implementations ───────────────────────────────── */

async function callOpenAI({ apiKey, model, systemPrompt, userMessage, signal, baseUrl }) {
  const url = `${baseUrl ?? "https://api.openai.com"}/v1/chat/completions`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body:    JSON.stringify({
      model,
      messages:    [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
      max_tokens:  500,
      temperature: 0.7
    }),
    signal
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `OpenAI API error: ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function callGemini({ apiKey, model, systemPrompt, userMessage, signal }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents:           [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig:   { maxOutputTokens: 500, temperature: 0.7 }
    }),
    signal
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Gemini API error: ${res.status}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
}

async function callGroq({ apiKey, model, systemPrompt, userMessage, signal }) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body:    JSON.stringify({
      model,
      messages:    [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
      max_tokens:  500,
      temperature: 0.7
    }),
    signal
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Groq API error: ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
