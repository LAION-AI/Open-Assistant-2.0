import { describe, expect, test, beforeEach } from "bun:test";
import { rateLimit, clearRateLimit, clientIp, _resetAllRateLimits } from "./ratelimit";

beforeEach(() => _resetAllRateLimits());

describe("rateLimit", () => {
  test("allows up to the limit, then blocks", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(rateLimit("k", 5, 60_000, now).allowed).toBe(true);
    }
    const blocked = rateLimit("k", 5, 60_000, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  test("reports remaining attempts", () => {
    const now = 1_000_000;
    expect(rateLimit("k", 3, 60_000, now).remaining).toBe(2);
    expect(rateLimit("k", 3, 60_000, now).remaining).toBe(1);
    expect(rateLimit("k", 3, 60_000, now).remaining).toBe(0);
  });

  test("the window resets once it expires", () => {
    const now = 1_000_000;
    rateLimit("k", 1, 60_000, now);
    expect(rateLimit("k", 1, 60_000, now).allowed).toBe(false);
    expect(rateLimit("k", 1, 60_000, now + 60_001).allowed).toBe(true);
  });

  test("keys are independent", () => {
    const now = 1_000_000;
    rateLimit("a", 1, 60_000, now);
    expect(rateLimit("a", 1, 60_000, now).allowed).toBe(false);
    expect(rateLimit("b", 1, 60_000, now).allowed).toBe(true);
  });

  test("clearing a key restores the allowance", () => {
    const now = 1_000_000;
    rateLimit("k", 1, 60_000, now);
    expect(rateLimit("k", 1, 60_000, now).allowed).toBe(false);
    clearRateLimit("k");
    expect(rateLimit("k", 1, 60_000, now).allowed).toBe(true);
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>) => new Request("http://x/", { headers });

  test("prefers the first x-forwarded-for hop", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
  });

  test("falls back to x-real-ip, then the default", () => {
    expect(clientIp(req({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(req({}))).toBe("unknown");
  });
});
