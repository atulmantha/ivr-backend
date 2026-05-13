function maskPhone(value) {
  if (!value && value !== 0) return value;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length <= 4) return "X".repeat(digits.length);
  return "X".repeat(Math.max(0, digits.length - 4)) + digits.slice(-4);
}

function maskEmail(value) {
  if (!value || typeof value !== "string") return value;
  const [local, domain] = value.split("@");
  if (!domain) return value;
  if (local.length <= 1) return `*${local}@${domain}`;
  return `${local[0]}***@${domain}`;
}

function maskCard(value) {
  if (!value || typeof value !== "string") return value;
  return value.replace(/\d(?=\d{4})/g, "X");
}

function maskSensitiveData(text) {
  if (!text || typeof text !== "string") return text;

  let masked = text;

  masked = masked.replace(
    /\b([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*?)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    (_match, first, _rest, domain) => `${first}***@${domain}`
  );

  masked = masked.replace(/(?:\b\d[ \-]*?){13,19}\b/g, (card) => maskCard(card));
  masked = masked.replace(/\+?\d[\d\-(). ]{6,}\d/g, (phone) => maskPhone(phone));

  return masked;
}

module.exports = { maskPhone, maskEmail, maskCard, maskSensitiveData };