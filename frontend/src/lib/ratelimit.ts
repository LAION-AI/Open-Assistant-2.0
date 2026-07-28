// Fixed-window rate limiting, held in memory.
//
// Scope note: this is per-process. The deployment runs a single frontend
// container, so it is sufficient; if the app is ever scaled horizontally these
// counters must move into the database, or an attacker could spread attempts
// across instances.

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

// Opportunistic sweep so abandoned keys can't grow the map without bound.
let lastSweep = Date.now();
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Count one attempt against `key`. Returns allowed=false once `limit` attempts
 * have been made inside `windowMs`.
 */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  sweep(now);
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
  }
  existing.count++;
  if (existing.count > limit) {
    return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: limit - existing.count, retryAfterSec: 0 };
}

/** Forget a key — call after a success so a legitimate user isn't penalised. */
export function clearRateLimit(key: string) {
  windows.delete(key);
}

/** Best-effort client identity for keying limits. */
export function clientIp(req: Request, fallback = "unknown"): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return (fwd.split(",")[0] || fallback).trim();
  return req.headers.get("x-real-ip") || fallback;
}

/** Testing seam. */
export function _resetAllRateLimits() {
  windows.clear();
}
