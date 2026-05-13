const crypto = require("crypto");

const KEY_ENV = process.env.NOTES_ENCRYPTION_KEY || "";
const KEY = KEY_ENV ? crypto.createHash("sha256").update(KEY_ENV, "utf8").digest() : null;
const ALGORITHM = "aes-256-gcm";
const PREFIX = "ENC:";

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function encryptText(text) {
  if (text == null || text === "") return text;
  if (!KEY) {
    console.warn("[encryption] NOTES_ENCRYPTION_KEY not set; storing plaintext fallback.");
    return text;
  }

  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    const encrypted = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}::${tag.toString("base64")}::${encrypted.toString("base64")}`;
  } catch (err) {
    console.error("[encryption] encryptText failed:", err.message);
    return text;
  }
}

function decryptText(text) {
  if (text == null || text === "") return text;
  if (!isEncrypted(text)) return text;
  if (!KEY) {
    console.warn("[encryption] NOTES_ENCRYPTION_KEY not set; returning encrypted text as-is.");
    return text;
  }

  try {
    const raw = text.slice(PREFIX.length);
    const parts = raw.split("::");
    if (parts.length !== 3) return text;
    const [ivB64, tagB64, payloadB64] = parts;
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const payload = Buffer.from(payloadB64, "base64");

    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    return text;
  }
}

module.exports = { encryptText, decryptText };