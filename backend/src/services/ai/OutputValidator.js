// OutputValidator — strict structured output parser and schema checker.
// It attempts to parse the assistant output as a JSON contract and validate the top-level shape.
// This file intentionally avoids trying to 'fix' free text. Free text is treated as plain message
// and cannot trigger actions. Only structured contracts can request actions.

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * parseStructuredOutput - parse JSON contract from model output
 * Accepts text that is exactly JSON or contains a JSON block; returns parsed contract.
 * Contract schema (top-level): { type: 'message'|'action_request'|'refusal', text?, action?, params?, metadata? }
 */
export function parseStructuredOutput(text) {
  if (!text || typeof text !== 'string') return { ok: false, error: 'no_text' };
  // Attempt direct JSON parse first
  let json = null;
  const trimmed = text.trim();
  try {
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      json = JSON.parse(trimmed);
    }
  } catch {}

  // If direct parse failed, try to find first JSON object block in text
  if (!json) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { json = JSON.parse(m[0]); } catch {}
    }
  }

  if (!json || !isObject(json)) return { ok: false, error: 'not_structured_json' };

  const type = String(json.type ?? '').trim();
  if (!['message','action_request','refusal'].includes(type)) return { ok: false, error: 'invalid_type' };

  if (type === 'message') {
    const textOut = json.text ?? '';
    return { ok: true, parsed: { type: 'message', text: String(textOut ?? '') } };
  }

  if (type === 'refusal') {
    const reason = json.reason ?? 'refused';
    return { ok: true, parsed: { type: 'refusal', reason: String(reason) } };
  }

  // action_request
  const action = String(json.action ?? '').trim();
  const params = json.params ?? {};
  if (!action) return { ok: false, error: 'missing_action' };
  if (!isObject(params)) return { ok: false, error: 'invalid_params' };
  return { ok: true, parsed: { type: 'action_request', action, params } };
}

// Deprecated: parsing responsibility moved to OutputParser.parse (pure parser). Keep this wrapper
// for backward compatibility but prefer importing OutputParser.parse.
import { parse as parseStructured } from './OutputParser.js';
export function parseStructuredOutput_deprecated(text) {
  return parseStructured(text);
}

export default {
  parseStructuredOutput_deprecated,
};
