// RFC 6238 TOTP + RFC 4648 base32, implemented on node:crypto so no third-party
// dependency handles our authentication secrets. Compatible with Authy, Google
// Authenticator, Microsoft Authenticator, 1Password, Apple Passwords, etc.
import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded — the encoding authenticator apps expect. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array {
  // Tolerate the spacing and casing users get when copying a secret by hand.
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 160-bit secret — the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The 6-digit code for a given secret at a point in time. */
export function totpCode(secret: string, at: number = Date.now(), step = 30, digits = 6): string {
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter. Split to stay clear of the 32-bit bitwise range.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", Buffer.from(base32Decode(secret))).update(buf).digest();
  // Dynamic truncation (RFC 4226 §5.4).
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * Verify a submitted code, accepting `window` steps either side so a slightly
 * out-of-sync phone clock still works. Comparison is timing-safe.
 */
export function verifyTotp(secret: string, code: string, at: number = Date.now(), window = 1): boolean {
  const submitted = (code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(submitted)) return false;
  for (let drift = -window; drift <= window; drift++) {
    const expected = totpCode(secret, at + drift * 30_000);
    const a = Buffer.from(expected);
    const b = Buffer.from(submitted);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** otpauth:// URI — what the QR code encodes. */
export function otpauthUrl(secret: string, account: string, issuer = "Open Assistant"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Human-enterable secret, grouped into fours for manual entry. */
export function formatSecretForDisplay(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

// --- Recovery codes ----------------------------------------------------------
// Single-use codes for when the authenticator device is lost. Stored only as
// SHA-256 hashes (they are high-entropy, so a plain hash is appropriate — the
// same reasoning as API keys, unlike low-entropy passwords which need argon2).

export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // 10 hex chars (~40 bits), split for readability: "a1b2c-3d4e5".
    const raw = randomBytes(5).toString("hex");
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export function hashBackupCode(code: string): string {
  return createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
}

export function normalizeBackupCode(code: string): string {
  return (code || "").trim().toLowerCase().replace(/[\s-]/g, "");
}

/**
 * Check a submitted recovery code against the stored hashes. Returns the
 * remaining hashes with the used one removed, or null if it did not match —
 * callers persist the remainder so each code works exactly once.
 */
export function consumeBackupCode(hashes: string[], submitted: string): string[] | null {
  const target = hashBackupCode(submitted);
  const idx = hashes.indexOf(target);
  if (idx === -1) return null;
  return hashes.filter((_, i) => i !== idx);
}
