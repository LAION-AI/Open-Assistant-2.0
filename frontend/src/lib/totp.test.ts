import { describe, expect, test } from "bun:test";
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCode,
  verifyTotp,
  otpauthUrl,
  generateBackupCodes,
  hashBackupCode,
  consumeBackupCode,
  normalizeBackupCode,
} from "./totp";

describe("base32", () => {
  test("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 128, 64, 7, 99]);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });

  test("matches RFC 4648 test vectors", () => {
    const enc = (s: string) => base32Encode(new TextEncoder().encode(s));
    expect(enc("f")).toBe("MY");
    expect(enc("fo")).toBe("MZXQ");
    expect(enc("foo")).toBe("MZXW6");
    expect(enc("foobar")).toBe("MZXW6YTBOI");
  });

  test("tolerates spaces, dashes and lowercase when decoding", () => {
    const secret = base32Encode(Uint8Array.from([1, 2, 3, 4, 5]));
    const messy = secret.toLowerCase().replace(/(.{2})/g, "$1 ");
    expect(Array.from(base32Decode(messy))).toEqual(Array.from(base32Decode(secret)));
  });

  test("rejects invalid characters", () => {
    expect(() => base32Decode("ABC!")).toThrow();
  });
});

describe("totp", () => {
  // RFC 6238 test vector: secret "12345678901234567890" (ASCII) as base32.
  const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

  test("matches the RFC 6238 reference vector at T=59", () => {
    // The published SHA-1 8-digit value is 94287082; we emit the low 6 digits.
    expect(totpCode(RFC_SECRET, 59 * 1000)).toBe("287082");
  });

  test("is stable within a 30s step and changes across steps", () => {
    const secret = generateTotpSecret();
    const t = 1_700_000_000_000;
    expect(totpCode(secret, t)).toBe(totpCode(secret, t + 29_000 - (t % 30_000)));
    expect(totpCode(secret, t)).not.toBe(totpCode(secret, t + 60_000));
  });

  test("verifies the current code", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(true);
  });

  test("accepts one step of clock drift either way", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_015_000;
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now)).toBe(true);
    // Two steps out is rejected.
    expect(verifyTotp(secret, totpCode(secret, now + 90_000), now)).toBe(false);
  });

  test("rejects malformed and wrong codes", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, "", now)).toBe(false);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
    expect(verifyTotp(secret, "abcdef", now)).toBe(false);
    const wrong = totpCode(secret, now) === "000000" ? "111111" : "000000";
    expect(verifyTotp(secret, wrong, now)).toBe(false);
  });

  test("different secrets produce different codes", () => {
    const now = Date.now();
    expect(totpCode(generateTotpSecret(), now)).not.toBe(totpCode(generateTotpSecret(), now));
  });

  test("otpauth url carries the fields authenticators need", () => {
    const url = otpauthUrl("JBSWY3DPEHPK3PXP", "user@example.com");
    expect(url).toStartWith("otpauth://totp/");
    expect(url).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(url).toContain("issuer=Open+Assistant");
    expect(url).toContain(encodeURIComponent("Open Assistant:user@example.com"));
  });
});

describe("backup codes", () => {
  test("generates the requested number of distinct codes", () => {
    const codes = generateBackupCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  test("normalizes formatting differences", () => {
    expect(normalizeBackupCode(" AB12C-DE34F ")).toBe("ab12cde34f");
    expect(hashBackupCode("ab12c-de34f")).toBe(hashBackupCode(" AB12C DE34F "));
  });

  test("consumes a code exactly once", () => {
    const codes = generateBackupCodes(3);
    const hashes = codes.map(hashBackupCode);

    const after = consumeBackupCode(hashes, codes[1]!);
    expect(after).not.toBeNull();
    expect(after).toHaveLength(2);
    // The same code cannot be reused against the reduced set.
    expect(consumeBackupCode(after!, codes[1]!)).toBeNull();
    // Other codes still work.
    expect(consumeBackupCode(after!, codes[0]!)).toHaveLength(1);
  });

  test("rejects an unknown code", () => {
    const hashes = generateBackupCodes(2).map(hashBackupCode);
    expect(consumeBackupCode(hashes, "ffff-fffff")).toBeNull();
  });
});
