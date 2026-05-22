export const PHONE_COUNTRIES = [
  { code: "NG", name: "Nigeria", dialCode: "234", example: "8012345678" },
  { code: "GH", name: "Ghana", dialCode: "233", example: "241234567" },
  { code: "KE", name: "Kenya", dialCode: "254", example: "712345678" },
  { code: "ZA", name: "South Africa", dialCode: "27", example: "821234567" },
  { code: "US", name: "United States", dialCode: "1", example: "2025550123" },
  { code: "GB", name: "United Kingdom", dialCode: "44", example: "7400123456" },
  { code: "IN", name: "India", dialCode: "91", example: "9876543210" },
  { code: "BR", name: "Brazil", dialCode: "55", example: "11987654321" },
];

export function getCountryByCode(code) {
  return PHONE_COUNTRIES.find((item) => item.code === code) ?? PHONE_COUNTRIES[0];
}

export function normalizePhoneNumber(countryCode, rawNumber) {
  const country = getCountryByCode(countryCode);
  let digits = String(rawNumber ?? "").replace(/\D/g, "");
  if (!digits) return "";

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith(country.dialCode)) return digits;
  if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");
  return `${country.dialCode}${digits}`;
}
