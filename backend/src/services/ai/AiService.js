/**
 * AiService — unified AI provider abstraction.
 * Supported providers: OpenAI, Google Gemini, Groq
 */

import crypto from "node:crypto";
import { logger } from "../../utils/logger.js";

const ALGORITHM = "aes-256-gcm";
const AI_TIMEOUT_MS = 25_000;
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
];
const GEMINI_MODEL_ALIASES = new Map([
  ["gemini-pro", "gemini-2.5-flash"],
  ["gemini-pro-latest", "gemini-2.5-flash"],
  ["gemini-1.0-pro", "gemini-2.5-flash"],
  ["gemini-1.0-pro-latest", "gemini-2.5-flash"],
  ["gemini-1.5-pro-latest", "gemini-1.5-pro"],
  ["gemini-1.5-flash-latest", "gemini-1.5-flash"],
  ["gemini-2.0-flash-exp", "gemini-2.0-flash"],
  ["gemini-2.0-flash-thinking-exp", "gemini-2.5-flash"],
]);

function extractTextContent(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          if (typeof item.text === "string") return item.text;
          if (typeof item.content === "string") return item.content;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.content === "string") return value.content.trim();
  }
  return "";
}

function extractGeminiParts(response) {
  return response?.candidates?.[0]?.content?.parts ?? [];
}

function normalizeAiResponse({ text = "", media = null } = {}) {
  return {
    text: typeof text === "string" ? text.trim() : "",
    media: media && typeof media === "object" ? media : null,
  };
}

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
    models:   GEMINI_MODELS,
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
 * @param {{provider:string, apiKey:string, model:string, systemPrompt?:string, userMessage?:string, messages?:Array<{role:string,content:string}>, metadata?:object, responseModalities?:string[]}} opts
 * @returns {Promise<{text:string, media:null|{type:string, data:string, mimetype:string, caption?:string}}>}
 */
export async function getAiCompletion({ provider, apiKey, model, systemPrompt, userMessage, messages = undefined, metadata = {}, responseModalities = undefined }) {
  const signal = AbortSignal.timeout(AI_TIMEOUT_MS);
  const providerId = provider?.toLowerCase?.() ?? "";
  const resolvedModel = providerId === "gemini" ? resolveGeminiModel(model) : model;

  logger.info({
    provider: providerId,
    model: resolvedModel,
    hasApiKey: Boolean(apiKey),
    ...metadata,
  }, "AI request sent");

  switch (providerId) {
    case "openai":
      return callOpenAI({ apiKey, model: model || "gpt-4o-mini", systemPrompt, userMessage, messages, signal, metadata });

    case "gemini":
      return callGemini({ apiKey, model: resolvedModel, systemPrompt, userMessage, messages, signal, metadata, responseModalities });

    case "groq":
      return callGroq({ apiKey, model: model || "llama-3.3-70b-versatile", systemPrompt, userMessage, messages, signal, metadata });

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
        return { ok: true, model: DEFAULT_GEMINI_MODEL };
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

async function callOpenAI({ apiKey, model, systemPrompt, userMessage, messages = undefined, signal, baseUrl, metadata = {} }) {
  const url = `${baseUrl ?? "https://api.openai.com"}/v1/chat/completions`;
  const resolvedMessages = Array.isArray(messages) && messages.length > 0
    ? messages
    : [{ role: "system", content: systemPrompt ?? "" }, { role: "user", content: userMessage ?? "" }];
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body:    JSON.stringify({
      model,
      messages: resolvedMessages,
      max_tokens:  500,
      temperature: 0.7
    }),
    signal
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    logger.warn({ provider: "openai", model, status: res.status, ...metadata }, "AI provider returned an error response");
    throw new Error(body?.error?.message || `OpenAI API error: ${res.status}`);
  }
  const data = await res.json();
  const reply = extractTextContent(data.choices?.[0]?.message?.content);
  if (!reply) {
    logger.warn({ provider: "openai", model, ...metadata }, "AI provider returned an empty response");
    throw new Error("OpenAI returned an empty response.");
  }
  logger.info({ provider: "openai", model, hasReply: Boolean(reply), ...metadata }, "AI response received");
  return normalizeAiResponse({ text: reply });
}

async function callGemini({ apiKey, model, systemPrompt, userMessage, messages = undefined, signal, metadata = {}, responseModalities = undefined }) {
  const resolvedModel = resolveGeminiModel(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${apiKey}`;
  const generationConfig = { maxOutputTokens: 500, temperature: 0.7 };
  if (Array.isArray(responseModalities) && responseModalities.length > 0) {
    generationConfig.responseModalities = responseModalities;
  }
  // Gemini supports structured system_instruction.parts and contents[].parts.
  // If callers provide a structured `messages` array, map it to Gemini parts preserving role semantics.
  const resolvedSystemParts = [];
  const resolvedContents = [];
  if (Array.isArray(messages) && messages.length > 0) {
    for (const m of messages) {
      const role = String(m.role ?? "user");
      const content = String(m.content ?? "");
      if (role === "system") resolvedSystemParts.push({ text: content });
      else resolvedContents.push({ role, parts: [{ text: content }] });
    }
  } else {
    resolvedSystemParts.push({ text: systemPrompt ?? "" });
    resolvedContents.push({ role: "user", parts: [{ text: userMessage ?? "" }] });
  }

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      system_instruction: { parts: resolvedSystemParts },
      contents:           resolvedContents,
      generationConfig
    }),
    signal
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    logger.warn({ provider: "gemini", model: resolvedModel, status: res.status, ...metadata }, "AI provider returned an error response");
    throw new Error(body?.error?.message || `Gemini API error: ${res.status}`);
  }
  const data = await res.json();
  const parts = extractGeminiParts(data);
  const reply = extractTextContent(parts);
  const inlineImagePart = parts.find((part) => {
    const blob = part?.inlineData ?? part?.inline_data ?? null;
    return blob?.data && String(blob?.mimeType ?? blob?.mime_type ?? "").startsWith("image/");
  });
  const media = inlineImagePart
    ? {
        type: "image",
        data: inlineImagePart.inlineData?.data ?? inlineImagePart.inline_data?.data,
        mimetype: inlineImagePart.inlineData?.mimeType ?? inlineImagePart.inline_data?.mime_type ?? "image/png",
      }
    : null;

  if (!reply && !media) {
    logger.warn({
      provider: "gemini",
      model: resolvedModel,
      finishReason: data?.candidates?.[0]?.finishReason,
      promptFeedback: data?.promptFeedback ?? null,
      ...metadata,
    }, "AI provider returned an empty response");
    throw new Error("Gemini returned an empty response.");
  }
  logger.info({ provider: "gemini", model: resolvedModel, hasReply: Boolean(reply), hasImage: Boolean(media), ...metadata }, "AI response received");
  return normalizeAiResponse({ text: reply, media });
}

function resolveGeminiModel(model) {
  const normalized = String(model ?? "").trim();
  if (!normalized) return DEFAULT_GEMINI_MODEL;
  return GEMINI_MODEL_ALIASES.get(normalized) ?? normalized;
}

async function callGroq({ apiKey, model, systemPrompt, userMessage, messages = undefined, signal, metadata = {} }) {
  const resolvedMessages = Array.isArray(messages) && messages.length > 0
    ? messages
    : [{ role: "system", content: systemPrompt ?? "" }, { role: "user", content: userMessage ?? "" }];
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body:    JSON.stringify({
      model,
      messages: resolvedMessages,
      max_tokens:  500,
      temperature: 0.7
    }),
    signal
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    logger.warn({ provider: "groq", model, status: res.status, ...metadata }, "AI provider returned an error response");
    throw new Error(body?.error?.message || `Groq API error: ${res.status}`);
  }
  const data = await res.json();
  const reply = extractTextContent(data.choices?.[0]?.message?.content);
  if (!reply) {
    logger.warn({ provider: "groq", model, ...metadata }, "AI provider returned an empty response");
    throw new Error("Groq returned an empty response.");
  }
  logger.info({ provider: "groq", model, hasReply: Boolean(reply), ...metadata }, "AI response received");
  return normalizeAiResponse({ text: reply });
}
