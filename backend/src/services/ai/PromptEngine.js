// PromptEngine: strict prompt compiler and validator
// Produces a messages array with strict partitioning and enforces validations

const DEFAULT_MAX_USER_PROMPT_CHARS = 4000;
const DEFAULT_BEHAVIOR_PROMPT = [
  "Act as the business representative for this WhatsApp line.",
  "Your public name is Medara unless BOT_CONFIG sets a different assistant name.",
  "Do not say you are an AI, language model, bot, or virtual assistant unless the customer explicitly asks about your identity.",
  "If asked who you are, say you are Medara, the business assistant for this WhatsApp line.",
  "Be warm, concise, practical, and honest.",
  "Do not invent products, pricing, policies, or promises that are not in BOT_CONFIG or CATALOG.",
].join(" ");

function isLikelyInstructional(text) {
  if (!text) return false;
  // simple heuristics: presence of imperative verbs at start, or instruction tokens
  const lowered = text.trim().toLowerCase();
  const instructionTokens = ['you must', 'you should', 'do this', 'ignore the', 'bypass', 'follow these', 'act as', 'pretend to be', 'replace system', 'system prompt'];
  for (const t of instructionTokens) if (lowered.includes(t)) return true;
  // starts with verb-ish word
  const firstWord = lowered.split(/\s+/)[0] || '';
  const verbs = ['create','write','generate','ignore','delete','remove','override','bypass','pretend','act'];
  if (verbs.includes(firstWord)) return true;
  return false;
}

function sanitizeUserContext(text) {
  if (!text) return '';
  // trim and collapse whitespace
  let s = text.replace(/\s+/g, ' ').trim();
  if (s.length > DEFAULT_MAX_USER_PROMPT_CHARS) s = s.slice(0, DEFAULT_MAX_USER_PROMPT_CHARS);
  // remove obvious jailbreak markers
  s = s.replace(/-----BEGIN SYSTEM-----[\s\S]*?-----END SYSTEM-----/ig, '');
  return s;
}

function validateUserContext(text) {
  // Reject if looks like instructions or contains system-like sections
  if (!text) return { ok: true };
  if (isLikelyInstructional(text)) return { ok: false, reason: 'user_context_looks_instructional' };
  if (/system prompt|assistant role|admin only|\[SYSTEM\]|<system>/i.test(text)) return { ok: false, reason: 'contains_system_tokens' };
  return { ok: true };
}

function buildSystemBlocks({ baseRules, botConfig, catalog, adminMeta, assistantName = "Medara" }) {
  // Only server-controlled content here. Never include user-provided prompts.
  const sections = [];
  sections.push(`IDENTITY:\nYou are ${assistantName}, the business WhatsApp assistant. Follow the configured system prompt closely unless it conflicts with safety rules.`);
  sections.push(`DEFAULT_BEHAVIOR:\n${DEFAULT_BEHAVIOR_PROMPT.replace("Medara", assistantName)}`);
  if (baseRules) sections.push(`SECURITY_RULES:\n${baseRules}`);
  if (adminMeta) sections.push(`ADMIN_CONTEXT:\n${JSON.stringify(adminMeta)}`);
  sections.push(`BOT_CONFIG:\n${botConfig || "No custom business prompt was configured. Use the default behavior, catalog, and admin context to answer naturally."}`);
  if (catalog) sections.push(`CATALOG:\n${catalog}`);
  return sections.join('\n\n');
}

function redactForLogs(text) {
  if (!text) return '';
  // mask phone numbers
  return text.replace(/\+?\d[\d \-]{6,}\d/g, '[REDACTED_PHONE]')
    .replace(/([A-Za-z0-9_\-]{20,})/g, '[REDACTED_TOKEN]');
}

/**
 * compilePrompt - produces messages array with strict partitioning
 * @param {object} opts
 *  - baseRules: string (server-controlled security rules)
 *  - botConfig: string (server-controlled bot config)
 *  - catalog: string (server-controlled catalog / tools description)
 *  - adminMeta: object (admin list, isAdmin flag inferred elsewhere)
 *  - userCustomPrompt: string (user-provided custom prompt, treated as CONTEXT ONLY)
 *  - userMessage: string (the actual user message to respond to)
 * @returns {object} { ok, messages, safeLog, debugLog }
 */
function compilePrompt(opts = {}) {
  const { baseRules, botConfig, catalog, adminMeta, userCustomPrompt, userMessage, assistantName } = opts;

  // Build system-only block(s)
  const systemBlock = buildSystemBlocks({ baseRules, botConfig, catalog, adminMeta, assistantName });

  // Sanitize user-provided context but DO NOT reject — treat as untrusted context-only
  const sanitizedUserContext = sanitizeUserContext(userCustomPrompt || '');
  const validation = validateUserContext(sanitizedUserContext);
  const warnings = [];
  if (!validation.ok) warnings.push(validation.reason || 'user_context_suspicious');

  // messages: system (server-controlled), user (untrusted context), user (actual message)
  const messages = [];
  if (systemBlock && systemBlock.length) messages.push({ role: 'system', content: systemBlock });
  if (sanitizedUserContext && sanitizedUserContext.length) messages.push({ role: 'user', content: `CONTEXT: ${sanitizedUserContext}` });
  messages.push({ role: 'user', content: userMessage || '' });

  const safeLog = redactForLogs(systemBlock + '\n' + sanitizedUserContext + '\n' + (userMessage || ''));
  const debugLog = systemBlock + '\n' + sanitizedUserContext + '\n' + (userMessage || '');

  return { ok: true, messages, safeLog, debugLog, warnings };
}

export {
  compilePrompt,
  validateUserContext,
  sanitizeUserContext,
  redactForLogs,
};
