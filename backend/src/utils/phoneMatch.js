export function normalizePhoneDigits(value = "") {
  return String(value ?? "").replace(/[^\d]/g, "");
}

/**
 * Flexible phone match — handles country-code prefixes and trailing digits.
 */
export function phonesMatch(a, b) {
  const left = normalizePhoneDigits(a);
  const right = normalizePhoneDigits(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.endsWith(right) || right.endsWith(left)) return true;
  const minLen = 10;
  if (left.length >= minLen && right.length >= minLen) {
    return left.slice(-minLen) === right.slice(-minLen);
  }
  return false;
}

export function isPhoneInAdminList(senderPhone, adminNumbers = []) {
  if (!senderPhone || !Array.isArray(adminNumbers) || adminNumbers.length === 0) return false;
  return adminNumbers.some((admin) => phonesMatch(admin, senderPhone));
}
