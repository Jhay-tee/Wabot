const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value = "") {
  return value.trim().toLowerCase();
}

export function isValidEmail(value = "") {
  return emailRegex.test(normalizeEmail(value));
}

export function sanitizeName(value = "", maxLength = 80) {
  return value.replace(/[<>]/g, "").trim().slice(0, maxLength);
}

export function isStrongPassword(password = "") {
  if (password.length < 8 || password.length > 128) return false;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasNumber = /\d/.test(password);
  return hasLower && hasUpper && hasNumber;
}
