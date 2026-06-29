const DEFAULT_CHUNK_SIZE = 4000;

/**
 * Split long text into WhatsApp-safe chunks (default 4000 chars per segment).
 * Prefers breaking on newlines, then spaces, to keep words intact.
 */
export function splitMessageChunks(text, maxLen = DEFAULT_CHUNK_SIZE) {
  const value = String(text ?? "");
  if (!value) return [];
  if (value.length <= maxLen) return [value];

  const chunks = [];
  let remaining = value;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

export function exceedsMessageLimit(text, maxLen = DEFAULT_CHUNK_SIZE) {
  return String(text ?? "").length > maxLen;
}
