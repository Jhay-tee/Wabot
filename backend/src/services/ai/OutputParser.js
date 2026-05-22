// OutputParser — pure, deterministic parser that extracts a structured contract from model output.
// This module MUST NOT perform any sanitization, validation, or fallback decisions. It only parses.

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function parse(text) {
  if (!text || typeof text !== 'string') return { ok: false, error: 'no_text' };
  const trimmed = text.trim();
  let json = null;
  try {
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      json = JSON.parse(trimmed);
    }
  } catch {}
  if (!json) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { json = JSON.parse(m[0]); } catch {}
    }
  }
  if (!json || !isObject(json)) return { ok: false, error: 'not_structured_json' };
  const type = String(json.type ?? '').trim();
  if (!type) return { ok: false, error: 'missing_type' };
  // return the raw parsed JSON as-is; no validation here
  return { ok: true, parsed: json };
}

export default { parse };
