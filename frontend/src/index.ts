import { serve } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import dns from "dns/promises";
import net from "net";
import { createHash } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { dbAdapter, db } from "./db/client";
import { users } from "./db/schema";
import {
  createSessionToken,
  verifySessionToken,
  createChallengeToken,
  verifyChallengeToken,
  createEmailActionToken,
  verifyEmailActionToken,
  createTwoFactorChallengeToken,
  verifyTwoFactorChallengeToken,
} from "./lib/session";
import { parseCookies, serializeCookie } from "./lib/cookies";
import {
  getLegalDoc,
  LEGAL_SLUGS,
  TERMS_VERSION,
  DATASET_CONSENT_VERSION,
  DATASET_CONSENT_TEXT,
} from "./lib/legal";
import { buildStoredPayload, type SourceEnvelope } from "./lib/unified";
import { parseCrushDb, parseHermesDb } from "./lib/tracedb";
import { emailEnabled, sendVerificationEmail, sendPasswordResetEmail, sendTwoFactorCodeEmail } from "./lib/email";
import {
  generateTotpSecret,
  verifyTotp,
  otpauthUrl,
  formatSecretForDisplay,
  generateBackupCodes,
  hashBackupCode,
  consumeBackupCode,
} from "./lib/totp";
import QRCode from "qrcode";
import { rateLimit, clearRateLimit, clientIp } from "./lib/ratelimit";
import indexHtml from "./index.html";
import pkg from "../package.json" with { type: "json" };

export const APP_VERSION: string = pkg.version;

const RP_NAME = "Open Assistant 2.0";
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8080";

// Load ALLOWED_HOSTS from env (split by comma)
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "localhost,openassistant.io")
  .split(",")
  .map(h => h.trim());

// Helper to determine dynamic RP ID and expectedOrigin based on ALLOWED_HOSTS
function getRpIdAndOrigin(req: Request) {
  const url = new URL(req.url);

  // Behind a TLS-terminating reverse proxy (e.g. Caddy) the server sees plain
  // HTTP, so trust X-Forwarded-* to reconstruct the browser's real https origin —
  // otherwise WebAuthn's expectedOrigin won't match and verification fails.
  const hostVal = req.headers.get("x-forwarded-host") || url.host;
  const host = (hostVal.split(",")[0] || hostVal).trim();
  const protoVal = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const proto = (protoVal.split(",")[0] || protoVal).trim();
  const hostname = (host.split(":")[0] || host).trim();

  const isAllowed = ALLOWED_HOSTS.includes(hostname);
  const rpId = isAllowed ? hostname : (ALLOWED_HOSTS[0] || "localhost");
  const origin = `${proto}://${host}`;
  return { rpId, origin };
}

// Helper to check which IP is active on a given port by attempting a TCP connection with a timeout
async function findActiveIP(ips: string[], port: number): Promise<string | null> {
  const promises = ips.map(ip => {
    return new Promise<string>((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(1000); // 1s timeout is safe for local LAN connectivity checks
      
      socket.connect(port, ip, () => {
        socket.destroy();
        resolve(ip);
      });
      
      const onError = () => {
        socket.destroy();
        reject();
      };
      
      socket.on("error", onError);
      socket.on("timeout", onError);
    });
  });

  try {
    return await Promise.any(promises);
  } catch {
    return null;
  }
}

// Helper to resolve local hostnames (e.g. Bonjour/mDNS names like pizero.local) to IP addresses.
// This allows Go proxy to connect directly without CGO dns resolution failures.
async function resolveLocalHostIfNecessary(urlStr: string): Promise<string> {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    const port = url.port ? parseInt(url.port) : (url.protocol === "https:" ? 443 : 80);

    // Check if it's already an IP address or localhost/127.0.0.1
    const isIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname) || hostname.includes(":");
    if (isIP || hostname === "localhost" || hostname === "127.0.0.1") {
      return urlStr;
    }

    // Only resolve single-label local hosts (like "pizero") or mDNS hosts (ending in ".local").
    // Do NOT resolve public internet domains (like "api.openai.com" or "googleapis.com")
    // because replacing the hostname with its IP address will cause TLS certificate validation failures.
    const isLocal = !hostname.includes(".") || hostname.endsWith(".local");
    if (!isLocal) {
      return urlStr;
    }

    console.log(`Resolving local hostname: ${hostname}`);
    const lookupResult = await dns.lookup(hostname, { all: true }).catch(err => {
      console.warn(`DNS lookup failed for ${hostname}:`, err.message);
      return [];
    });

    const ips: string[] = [];
    if (Array.isArray(lookupResult)) {
      lookupResult.forEach(entry => {
        if (entry.family === 4) { // Prefer IPv4 for local network compatibility
          ips.push(entry.address);
        }
      });
      // Fallback to IPv6 if no IPv4 was found
      if (ips.length === 0) {
        lookupResult.forEach(entry => ips.push(entry.address));
      }
    } else if (lookupResult && (lookupResult as any).address) {
      ips.push((lookupResult as any).address);
    }

    if (ips.length > 0) {
      console.log(`Resolved hostname ${hostname} to IPs: ${ips.join(", ")}`);
      // Try to find the active IP listening on the target port
      const activeIP = await findActiveIP(ips, port);
      if (activeIP) {
        console.log(`Using active IP: ${activeIP} for ${hostname}:${port}`);
        url.hostname = activeIP;
        return url.toString();
      } else {
        // Fallback to the first resolved IP if none answered the TCP check
        console.log(`No active IP responded on port ${port}, falling back to first resolved: ${ips[0]}`);
        url.hostname = ips[0] || "";
        return url.toString();
      }
    }
  } catch (err: any) {
    console.warn(`Warning: failed to resolve hostname in URL ${urlStr}: ${err.message}`);
  }
  return urlStr;
}

// Ensure database tables are migrated
import { runMigrations } from "./db/migrate";
runMigrations();

// Fetch the available model ids from a user's OpenAI-compatible endpoint.
async function resolveModelList(byoeUrl: string, byoeKey?: string | null): Promise<string[]> {
  const cleaned = byoeUrl.trim().replace(/\/$/, "");
  const resolved = await resolveLocalHostIfNecessary(cleaned);
  let modelsUrl = resolved.endsWith("/models") ? resolved : `${resolved}/models`;
  const isGoogle = modelsUrl.includes("googleapis.com");
  const headers: Record<string, string> = {};

  if (byoeKey && byoeKey.trim()) {
    if (isGoogle) {
      const separator = modelsUrl.includes("?") ? "&" : "?";
      modelsUrl = `${modelsUrl}${separator}key=${byoeKey.trim()}`;
    } else {
      headers["Authorization"] = `Bearer ${byoeKey.trim()}`;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(modelsUrl, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to fetch models: ${res.statusText}`);
    const data = await res.json();

    // Parse Google response format
    if (isGoogle && Array.isArray(data?.models)) {
      return data.models.map((m: any) => {
        const name = m.name || "";
        return name.replace(/^models\//, "");
      }).filter(Boolean);
    }

    // Fallback: Parse OpenAI standard response format
    if (Array.isArray(data?.data)) {
      return data.data.map((m: any) => m.id).filter(Boolean);
    }
    if (Array.isArray(data?.models)) {
      return data.models.map((m: any) => {
        const val = m.id || m.name || "";
        return val.replace(/^models\//, "");
      }).filter(Boolean);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// The stored {prompt, response, tokens} conversion lives in lib/unified.ts —
// every upload path (trace ingest, redaction, backend /api/ingest) normalizes
// to the same unified schema so rows are reproducible and back-convertible
// regardless of source. The prompt can carry a verbatim copy of the original
// trace file (SourceEnvelope) for lossless back-conversion to the source format.

// Original trace files are already capped client-side at 10 MB; this server
// cap only guards against hand-crafted requests.
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/** Deterministic conversation id for an uploaded trace, anchored on the
 * verbatim source when present (falls back to the messages). Re-uploading the
 * same session upserts one row; a redacted re-upload gets a new id, which is
 * the safe direction. */
function stableTraceId(platform: string, tr: any): string {
  const seed =
    typeof tr?.source?.text === "string" && tr.source.text ? tr.source.text : JSON.stringify(tr?.messages ?? []);
  return "import-" + createHash("sha256").update(`${platform}:${seed}`).digest("hex").slice(0, 24);
}

/** Validate a client-supplied source envelope; null when absent or malformed. */
function sanitizeSource(s: any): SourceEnvelope | null {
  if (!s || typeof s !== "object" || typeof s.text !== "string" || !s.text) return null;
  if (s.text.length > MAX_SOURCE_BYTES) return null;
  return {
    format: String(s.format || "trace").slice(0, 40),
    kind: s.kind === "json" ? "json" : "jsonl",
    ...(typeof s.name === "string" && s.name ? { name: s.name.slice(0, 200) } : {}),
    text: s.text,
  };
}

// Parse an OpenCode SQLite database (newer versions store sessions in
// ~/.local/share/opencode/opencode.db) into preview-able trace objects.
function parseOpencodeDb(dbPath: string): any[] {
  // Read-write (on the disposable temp copy) so SQLite can apply the WAL —
  // readonly fails to open WAL-mode databases.
  const ocdb = new Database(dbPath, { readwrite: true });
  try {
    const sessions = ocdb.query("SELECT id, title, model FROM session").all() as any[];
    const traces: any[] = [];
    for (const s of sessions) {
      const msgRows = ocdb
        .query("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC")
        .all(s.id) as any[];

      const messages: any[] = [];
      // Raw session/message/part rows, kept as JSONL alongside the normalized
      // messages so the OpenCode records are fully reconstructable (source is
      // a SQLite DB, so fidelity is per-row JSON rather than byte-for-byte).
      const sourceLines: string[] = [JSON.stringify({ table: "session", row: s })];
      for (const m of msgRows) {
        let md: any = {};
        try {
          md = JSON.parse(m.data);
        } catch {}
        const partRows = ocdb
          .query("SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC")
          .all(m.id) as any[];

        const parts: any[] = [];
        let text = "";
        let reasoning = "";
        const tools: any[] = [];
        for (const p of partRows) {
          let pd: any = {};
          try {
            pd = JSON.parse(p.data);
          } catch {
            pd = { raw: p.data };
          }
          parts.push(pd);
          if (pd.type === "text" && pd.text) text += (text ? "\n" : "") + pd.text;
          else if (pd.type === "reasoning" && pd.text) reasoning += (reasoning ? "\n" : "") + pd.text;
          else if (pd.type === "tool") {
            tools.push({
              ...(pd.callID ? { id: pd.callID } : {}),
              type: "function",
              function: { name: pd.tool || "tool", arguments: JSON.stringify(pd.state?.input ?? {}) },
            });
          }
        }
        sourceLines.push(JSON.stringify({ table: "message", id: m.id, data: md, parts }));
        const msg: any = { role: md.role || "user", content: text };
        if (reasoning) msg.reasoning = reasoning;
        if (tools.length) msg.tool_calls = tools;
        messages.push(msg);
      }

      const filtered = messages.filter(m => m.content || m.tool_calls?.length || m.reasoning);
      if (filtered.length === 0) continue;

      let model = "";
      try {
        model = JSON.parse(s.model)?.id || "";
      } catch {}
      const firstUser = filtered.find(m => m.role === "user");
      const title = (s.title || firstUser?.content || "OpenCode session").toString().slice(0, 80);
      const turnCount = Math.max(filtered.filter(m => m.role === "user").length, 1);
      traces.push({
        ok: true,
        fileName: s.id,
        platform: "opencode",
        model,
        messages: filtered,
        turnCount,
        title,
        source: { format: "opencode", kind: "jsonl", name: `${s.id}.jsonl`, text: sourceLines.join("\n") },
      });
    }
    return traces;
  } finally {
    ocdb.close();
  }
}

// --- Antigravity (Gemini) conversations -------------------------------------
// Antigravity stores one SQLite DB per conversation; each `steps` row holds a
// protobuf-encoded payload. There's no public schema, so we recover the
// human-readable text by raw-walking the protobuf wire format: length-delimited
// fields that parse as a valid sub-message are recursed into; the rest are
// treated as leaf strings and kept if they look like content (not ids/base64).

function agIsValidMessage(b: Uint8Array): boolean {
  let i = 0;
  if (b.length === 0) return false;
  while (i < b.length) {
    let tag = 0, shift = 0;
    while (true) { if (i >= b.length) return false; const x = b[i++] ?? 0; tag |= (x & 0x7f) << shift; if (!(x & 0x80)) break; shift += 7; if (shift > 35) return false; }
    const wt = tag & 7, fn = tag >>> 3;
    if (fn === 0) return false;
    if (wt === 0) { while (i < b.length && ((b[i] ?? 0) & 0x80)) i++; if (i >= b.length) return false; i++; }
    else if (wt === 1) { i += 8; if (i > b.length) return false; }
    else if (wt === 5) { i += 4; if (i > b.length) return false; }
    else if (wt === 2) { let len = 0, sh = 0; while (true) { if (i >= b.length) return false; const x = b[i++] ?? 0; len |= (x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7; if (sh > 35) return false; } if (i + len > b.length) return false; i += len; }
    else return false;
  }
  return true;
}

function agCleanText(s: string): string {
  let r = "";
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 9 || c === 10 || c >= 32) r += s[k];
  }
  return r.trim();
}

function agIsContent(s: string): boolean {
  if (s.length < 6) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(s)) return false; // uuid
  if (s.length > 20 && /^[A-Za-z0-9+/=_-]+$/.test(s) && !/[\s{}":/]/.test(s)) return false; // base64
  if (/^(sessionID|req_[a-z]|toolu_|cascade|reqid)/i.test(s) && !/\s/.test(s) && s.length < 60) return false;
  return true;
}

function agExtractText(buf: Uint8Array): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const dec = new TextDecoder("utf-8", { fatal: false });
  function walk(b: Uint8Array, depth: number) {
    if (depth > 16) return;
    let i = 0;
    while (i < b.length) {
      let tag = 0, shift = 0, ok = true;
      while (true) { if (i >= b.length) { ok = false; break; } const x = b[i++] ?? 0; tag |= (x & 0x7f) << shift; if (!(x & 0x80)) break; shift += 7; if (shift > 35) { ok = false; break; } }
      if (!ok) break;
      const wt = tag & 7;
      if (wt === 0) { while (i < b.length && ((b[i] ?? 0) & 0x80)) i++; i++; }
      else if (wt === 1) i += 8;
      else if (wt === 5) i += 4;
      else if (wt === 2) {
        let len = 0, sh = 0, ok2 = true;
        while (true) { if (i >= b.length) { ok2 = false; break; } const x = b[i++] ?? 0; len |= (x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7; if (sh > 35) { ok2 = false; break; } }
        if (!ok2 || i + len > b.length) break;
        const sub = b.subarray(i, i + len); i += len;
        if (len > 2 && agIsValidMessage(sub)) walk(sub, depth + 1);
        else { const s = agCleanText(dec.decode(sub)); if (agIsContent(s) && !seen.has(s)) { seen.add(s); out.push(s); } }
      } else break;
    }
  }
  walk(buf, 0);
  return out.join("\n").trim();
}

function parseAntigravityDb(dbPath: string): any[] {
  const db = new Database(dbPath, { readwrite: true });
  try {
    const steps = db.query("SELECT idx, step_type, step_payload FROM steps ORDER BY idx ASC").all() as any[];
    const messages: any[] = [];
    for (const s of steps) {
      if (!s.step_payload) continue;
      const buf: Uint8Array = s.step_payload instanceof Uint8Array ? s.step_payload : new Uint8Array(s.step_payload);
      let text = agExtractText(buf);
      if (!text) continue;
      if (text.length > 200000) text = text.slice(0, 200000);
      messages.push({ role: s.step_type === 14 ? "user" : "assistant", content: text });
    }
    if (messages.length === 0) return [];
    const firstUser = messages.find(m => m.role === "user");
    const title = (firstUser?.content || "Antigravity conversation").replace(/\s+/g, " ").trim().slice(0, 80);
    const turnCount = Math.max(messages.filter(m => m.role === "user").length, 1);
    return [{
      ok: true,
      fileName: dbPath.split("/").pop() || "antigravity.db",
      platform: "antigravity",
      model: "",
      messages,
      turnCount,
      title,
    }];
  } finally {
    db.close();
  }
}

// Detect the SQLite schema and parse with the matching extractor.
function parseSqliteDb(dbPath: string): any[] {
  let tables: string[] = [];
  try {
    const db = new Database(dbPath, { readwrite: true });
    tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r: any) => r.name);
    db.close();
  } catch {
    return [];
  }
  if (tables.includes("session") && tables.includes("message") && tables.includes("part")) return parseOpencodeDb(dbPath);
  if (tables.includes("steps") && tables.includes("trajectory_meta")) return parseAntigravityDb(dbPath);
  if (tables.includes("sessions") && tables.includes("messages")) {
    // Crush stores block "parts" per message; Hermes uses near-OpenAI columns.
    let cols: string[] = [];
    try {
      const db = new Database(dbPath, { readwrite: true });
      cols = (db.query("PRAGMA table_info(messages)").all() as any[]).map((r: any) => r.name);
      db.close();
    } catch {
      return [];
    }
    if (cols.includes("parts")) return parseCrushDb(dbPath);
    if (cols.includes("tool_calls")) return parseHermesDb(dbPath);
  }
  return [];
}

// Shared chat-completion forwarder used by both the cookie-auth web UI and the
// API-key proxy for external tools. Resolves the model (client choice wins),
// routes through the Go logging proxy, and returns the streamed response.
async function proxyChatCompletion(
  user: any,
  reqBody: any,
  conversationId: string | null,
  platform: string,
  useV1Beta: boolean = false,
): Promise<Response> {
  const isBYOE = !!user.byoeUrl;
  if (!isBYOE && user.credits <= 0) {
    return Response.json({ error: "Out of credits! Please configure BYOE in settings." }, { status: 402 });
  }

  // Model selection on the fly: explicit request model (model or model_id), else the saved default.
  const reqModel = reqBody?.model || reqBody?.model_id;
  const model =
    (typeof reqModel === "string" && reqModel.trim()) || user.byoeModel || "gpt-4o";
  reqBody.model = model;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-User-Id": user.id,
    "X-Platform": platform || "api",
  };
  if (conversationId) headers["X-Conversation-Id"] = conversationId;
  if (isBYOE) {
    headers["X-BYOE-Url"] = await resolveLocalHostIfNecessary(user.byoeUrl);
    if (user.byoeKey) headers["X-BYOE-Key"] = user.byoeKey;
    // No X-BYOE-Model: the resolved model now travels in the body and is logged.
  }

  const endpointPath = useV1Beta ? "/v1beta/chat/completions" : "/v1/chat/completions";
  const response = await fetch(`${BACKEND_URL}${endpointPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    return new Response(errText, { status: response.status, headers: { "Content-Type": "text/plain" } });
  }

  if (!isBYOE) await dbAdapter.updateCredits(user.id, -10);

  const contentType = reqBody?.stream === false ? "application/json" : "text/event-stream";
  return new Response(response.body, {
    status: 200,
    headers: { "Content-Type": contentType, "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}

// --- Session helpers (shared by passkey + email auth) ----------------------
const SESSION_MAX_AGE = 7 * 24 * 3600;
// True when the browser is talking HTTPS. The server sits behind a
// TLS-terminating proxy, so its own url.protocol is always http — the forwarded
// header is the only accurate signal.
function isHttps(req: Request): boolean {
  const fwd = (req.headers.get("x-forwarded-proto") || "").split(",")[0]?.trim();
  if (fwd) return fwd === "https";
  return new URL(req.url).protocol === "https:";
}

// SameSite=Lax blocks the cookie on cross-site POSTs (CSRF) while keeping
// ordinary top-level navigation into the app working.
function sessionSetCookie(token: string, req?: Request) {
  return serializeCookie("session", token, {
    httpOnly: true,
    secure: req ? isHttps(req) : false,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}
async function loginResponse(user: { id: string; username: string }, body: any, req?: Request) {
  const token = await createSessionToken({ userId: user.id, username: user.username });
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", sessionSetCookie(token, req));
  return new Response(JSON.stringify(body), { headers });
}

async function userFromSession(req: Request) {
  const cookies = parseCookies(req.headers.get("cookie"));
  const st = cookies["session"];
  if (!st) return null;
  const payload = await verifySessionToken(st);
  if (!payload) return null;
  return dbAdapter.getUser(payload.userId);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Best-effort identification of which tool a proxied request came from. Honors
// an explicit X-Platform header, otherwise sniffs the User-Agent.
function detectPlatform(req: Request): string {
  const explicit = (req.headers.get("X-Platform") || "").trim();
  if (explicit) return explicit.slice(0, 40);
  const ua = (req.headers.get("User-Agent") || "").toLowerCase();
  if (!ua) return "api";
  if (ua.includes("claude")) return "claude-code";
  if (ua.includes("opencode")) return "opencode";
  if (ua.includes("cursor")) return "cursor";
  if (ua.includes("copilot") || ua.includes("vscode") || ua.includes("vs code")) return "vscode";
  if (ua.includes("hermes")) return "hermes";
  if (ua.includes("continue")) return "continue";
  if (ua.includes("cline")) return "cline";
  if (ua.includes("aider")) return "aider";
  if (ua.includes("openai")) return "openai-sdk";
  if (ua.includes("python")) return "python";
  if (ua.includes("curl")) return "curl";
  if (ua.includes("node")) return "node";
  const firstPart = ua.split("/")[0] || "api";
  return firstPart.slice(0, 40) || "api";
}

// Feedback API is accessible to (a) the configured bearer token — for an
// automation agent — or (b) a logged-in admin (for the dashboard).
const FEEDBACK_TOKEN = process.env.FEEDBACK_TOKEN || "";

async function feedbackAuthorized(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (FEEDBACK_TOKEN && token && token === FEEDBACK_TOKEN) return true;
  const cookies = parseCookies(req.headers.get("cookie"));
  const st = cookies["session"];
  if (st) {
    const payload = await verifySessionToken(st);
    if (payload) {
      const user = await dbAdapter.getUser(payload.userId);
      if (user && user.isAdmin === 1) return true;
    }
  }
  return false;
}

// API keys are high-entropy random tokens, so a single SHA-256 is the standard,
// safe way to store them (unlike low-entropy passwords, which need bcrypt/
// argon2). Only the hash is ever persisted; the plaintext is shown to the user
// exactly once, at creation. The Go ingestion backend hashes identically.
function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw.trim()).digest("hex");
}

// Never send secret credentials (password hash, API-key hash, TOTP secret,
// recovery-code hashes) to the browser — expose booleans instead. Use wherever
// a full user record is returned to a client.
function clientUser(user: any, extra: Record<string, unknown> = {}) {
  if (!user) return user;
  const { passwordHash, apiKey, totpSecret, backupCodes, ...safe } = user;
  let backupCodesRemaining = 0;
  try {
    backupCodesRemaining = backupCodes ? (JSON.parse(backupCodes) as string[]).length : 0;
  } catch {}
  return {
    ...safe,
    hasPassword: !!passwordHash,
    hasApiKey: !!apiKey,
    twoFactorEnabled: !!user.twofaMethod,
    twoFactorMethod: user.twofaMethod ?? null,
    backupCodesRemaining,
    onboarded: !!user.onboardedAt,
    // Derived so the UI never has to know the version comparison rule: a
    // version bump means the stored acceptance no longer covers the current
    // document, and the user has to be asked again.
    termsCurrent: user.termsVersion === TERMS_VERSION,
    datasetConsentCurrent:
      user.datasetConsent === 1 && user.datasetConsentVersion === DATASET_CONSENT_VERSION,
    ...extra,
  };
}

// --- Two-factor auth -------------------------------------------------------
// 2FA applies only to password logins. Passkeys are already phishing-resistant
// and hardware-bound, so a second factor there would add friction, not safety.

function tooManyAttempts(retryAfterSec: number) {
  return Response.json(
    { error: `Too many attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function sixDigitCode(): string {
  // Rejection-free: 6 bytes -> uniform enough for a short-lived, rate-limited code.
  return String(Math.floor(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000)).padStart(6, "0");
}

async function issueEmailOtp(user: any): Promise<boolean> {
  if (!user?.email) return false;
  const code = sixDigitCode();
  await dbAdapter.savePendingOtp(user.id, hashBackupCode(code), Date.now() + OTP_TTL_MS);
  return sendTwoFactorCodeEmail(user.email, code, OTP_TTL_MS / 60000);
}

/**
 * Validate a second factor. Recovery codes are accepted for both methods, since
 * they exist precisely for when the primary factor is unavailable.
 * Returns null on success, or a user-facing error message.
 */
async function checkSecondFactor(user: any, code: string): Promise<string | null> {
  const submitted = (code || "").trim();
  if (!submitted) return "Enter your verification code";

  // Recovery code path (single use).
  const storedHashes: string[] = user.backupCodes ? JSON.parse(user.backupCodes) : [];
  if (storedHashes.length) {
    const remaining = consumeBackupCode(storedHashes, submitted);
    if (remaining) {
      await dbAdapter.setBackupCodes(user.id, remaining);
      return null;
    }
  }

  if (user.twofaMethod === "totp") {
    if (!user.totpSecret) return "Two-factor is misconfigured — use a recovery code";
    return verifyTotp(user.totpSecret, submitted) ? null : "That code isn't right — check your authenticator app";
  }

  if (user.twofaMethod === "email") {
    const pending = await dbAdapter.getPendingOtp(user.id);
    if (!pending) return "That code has expired — request a new one";
    if (pending.expiresAt < Date.now()) {
      await dbAdapter.clearPendingOtp(user.id);
      return "That code has expired — request a new one";
    }
    if (pending.attempts >= OTP_MAX_ATTEMPTS) {
      await dbAdapter.clearPendingOtp(user.id);
      return "Too many attempts — request a new code";
    }
    if (pending.codeHash === hashBackupCode(submitted)) {
      await dbAdapter.clearPendingOtp(user.id);
      return null;
    }
    await dbAdapter.bumpOtpAttempts(user.id);
    return "That code isn't right — check your email";
  }

  return "Two-factor is not enabled for this account";
}

/**
 * Write the two consent records a new account starts with.
 *
 * Terms acceptance is a precondition for the account existing at all; dataset
 * consent is recorded either way — an explicit "declined" row at signup is
 * worth having, because "never asked" and "asked and said no" are different
 * facts when a dataset release has to account for its provenance.
 */
async function recordSignupConsent(
  userId: string,
  datasetConsent: boolean,
  showInLeaderboard: boolean
): Promise<void> {
  await dbAdapter.recordConsent(userId, "terms", true, TERMS_VERSION, "signup");
  await dbAdapter.recordConsent(userId, "dataset", datasetConsent, DATASET_CONSENT_VERSION, "signup");
  // Leaderboard visibility is consent-based too, but it needs no versioned
  // document behind it — the column is the whole record.
  if (showInLeaderboard) {
    await dbAdapter.updateShowInLeaderboard(userId, true);
  }
}

// Per-user contribution rollup from the Go backend, plus the global totals
// derived from it. Shared by the leaderboard and the README stats badges.
type ContributionEntry = { userId: string; totalTokens: number; totalTraces: number };

async function fetchContributionStats(): Promise<{
  entries: ContributionEntry[];
  tokens: number;
  traces: number;
  contributors: number;
}> {
  const res = await fetch(`${BACKEND_URL}/api/leaderboard`);
  if (!res.ok) {
    throw new Error("Failed to fetch leaderboard from backend");
  }
  const data = await res.json();
  const entries: ContributionEntry[] = data.leaderboard || [];
  return {
    entries,
    tokens: entries.reduce((acc, e) => acc + e.totalTokens, 0),
    traces: entries.reduce((acc, e) => acc + e.totalTraces, 0),
    contributors: entries.length,
  };
}

// Compact counts for badges: 1234 → "1.2k", 5_400_000 → "5.4M".
function formatCount(n: number): string {
  const units: [number, string][] = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) {
      return `${(n / size).toFixed(1).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(n);
}

// Resolve a user from an `Authorization: Bearer <api key>` header.
async function userFromApiKey(req: Request): Promise<any | null> {
  const auth = req.headers.get("Authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key) return null;
  return dbAdapter.getUserByApiKey(hashApiKey(key));
}

const server = serve({
  port: PORT,
  // Chat completions can stream for a while (long reasoning); the default 10s
  // idle timeout cuts them off. Allow up to 180s of idle between chunks.
  idleTimeout: 180,
  // Trace SQLite uploads (OpenCode/Antigravity) can be large.
  maxRequestBodySize: 256 * 1024 * 1024,
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
  routes: {
    // Serve index.html for UI pages (Single Page App routing)
    "/*": indexHtml,

    // Version + liveness. Unauthenticated by design so a deploy can confirm the
    // new build is actually serving, not merely that something responds.
    "/api/health": async () =>
      Response.json({ ok: true, name: "open-assistant-2", version: APP_VERSION }),

    // Document versions and the exact consent wording. Public: the signup form
    // needs it before an account exists, and § 5 DDG requires the Impressum to
    // be reachable without registering.
    "/api/legal": async () =>
      Response.json({
        slugs: LEGAL_SLUGS,
        termsVersion: TERMS_VERSION,
        datasetConsentVersion: DATASET_CONSENT_VERSION,
        datasetConsentText: DATASET_CONSENT_TEXT,
      }),

    "/api/legal/:slug": async req => {
      const doc = getLegalDoc(req.params.slug);
      if (!doc) return Response.json({ error: "Unknown document" }, { status: 404 });
      // Short cache: these change rarely, but a stale privacy policy in a proxy
      // is worse than an extra request.
      return Response.json(doc, { headers: { "Cache-Control": "public, max-age=300" } });
    },

    // Get current authenticated user
    "/api/auth/me": async req => {
      const cookies = parseCookies(req.headers.get("cookie"));
      const sessionToken = cookies["session"];
      if (!sessionToken) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const payload = await verifySessionToken(sessionToken);
      if (!payload) {
        return Response.json({ error: "Invalid session" }, { status: 401 });
      }

      const user = await dbAdapter.getUser(payload.userId);
      if (!user) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const creds = await dbAdapter.getUserCredentials(user.id);
      return Response.json({ user: clientUser(user, { hasPasskey: creds.length > 0 }) });
    },

    // --- Email + password auth (passkeys remain the recommended default) ---

    // Whether email login is available (drives the UI).
    "/api/auth/email/status": async () => Response.json({ enabled: true, emailVerification: emailEnabled }),

    "/api/auth/email/register": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const { username, email, password, acceptedTerms, datasetConsent, showInLeaderboard } =
          await req.json();
        const u = (username || "").trim();
        const e = (email || "").trim().toLowerCase();
        if (u.length < 3) return Response.json({ error: "Username must be at least 3 characters" }, { status: 400 });
        if (!EMAIL_RE.test(e)) return Response.json({ error: "Enter a valid email address" }, { status: 400 });
        if ((password || "").length < 8) return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
        // Enforced server-side, not just in the form: an account may not exist
        // without a recorded acceptance of the terms.
        if (acceptedTerms !== true) {
          return Response.json({ error: "You must accept the Terms of Service and Privacy Policy" }, { status: 400 });
        }
        if (await dbAdapter.getUserByUsername(u)) return Response.json({ error: "Username already taken" }, { status: 400 });
        if (await dbAdapter.getUserByEmail(e)) return Response.json({ error: "Email already registered" }, { status: 400 });

        const hash = await Bun.password.hash(password);
        const user = await dbAdapter.createEmailUser(u, e, hash);
        await recordSignupConsent(user.id, datasetConsent === true, showInLeaderboard === true);

        if (emailEnabled) {
          const token = await createEmailActionToken({ purpose: "verify", userId: user.id }, "24h");
          const link = `${getRpIdAndOrigin(req).origin}/api/auth/email/verify?token=${encodeURIComponent(token)}`;
          await sendVerificationEmail(e, link);
          return Response.json({ success: true, needsVerification: true });
        }
        // No SMTP configured — auto-verify and sign in.
        await dbAdapter.setEmailVerified(user.id, true);
        return loginResponse(user, { success: true, verified: true, user: { id: user.id, username: user.username } }, req);
      } catch (err: any) {
        console.error("email register error:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Clicking the verification link signs the user in and redirects to the app.
    "/api/auth/email/verify": async req => {
      const token = new URL(req.url).searchParams.get("token") || "";
      const payload = await verifyEmailActionToken(token, "verify");
      if (!payload) {
        return new Response(null, { status: 303, headers: { Location: "/?verify=failed" } });
      }
      await dbAdapter.setEmailVerified(payload.userId, true);
      const user = await dbAdapter.getUser(payload.userId);
      const headers = new Headers({ Location: "/?verified=1" });
      if (user) {
        headers.append("Set-Cookie", sessionSetCookie(await createSessionToken({ userId: user.id, username: user.username }), req));
      }
      return new Response(null, { status: 303, headers });
    },

    "/api/auth/email/login": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const { email, password } = await req.json();
        const normalized = (email || "").trim().toLowerCase();
        // Throttle both the account and the origin, so neither a targeted
        // guessing run nor a spray across many accounts is cheap.
        const byAccount = rateLimit(`login:acct:${normalized}`, 10, 15 * 60_000);
        const byIp = rateLimit(`login:ip:${clientIp(req)}`, 30, 15 * 60_000);
        if (!byAccount.allowed) return tooManyAttempts(byAccount.retryAfterSec);
        if (!byIp.allowed) return tooManyAttempts(byIp.retryAfterSec);

        const user = await dbAdapter.getUserByEmail(normalized);
        if (!user || !user.passwordHash || !(await Bun.password.verify(password || "", user.passwordHash))) {
          return Response.json({ error: "Invalid email or password" }, { status: 401 });
        }
        clearRateLimit(`login:acct:${normalized}`);
        if (emailEnabled && !user.emailVerified) {
          return Response.json({ error: "Please verify your email first", needsVerification: true }, { status: 403 });
        }
        // Password was correct but a second factor is owed: hand back a signed
        // challenge instead of a session, so no cookie exists until 2FA passes.
        if (user.twofaMethod) {
          if (user.twofaMethod === "email") await issueEmailOtp(user);
          return Response.json({
            twoFactorRequired: true,
            method: user.twofaMethod,
            challenge: await createTwoFactorChallengeToken({ userId: user.id, method: user.twofaMethod }),
          });
        }
        return loginResponse(user, { success: true, user: { id: user.id, username: user.username } }, req);
      } catch (err: any) {
        console.error("email login error:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Complete a password login by presenting the second factor.
    "/api/auth/2fa/verify": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const { challenge, code } = await req.json();
        const payload = await verifyTwoFactorChallengeToken(challenge || "");
        if (!payload) return Response.json({ error: "This sign-in attempt expired — start again" }, { status: 401 });
        const user = await dbAdapter.getUser(payload.userId);
        if (!user) return Response.json({ error: "Account not found" }, { status: 404 });

        // The challenge lives for 10 minutes; unlimited guesses inside that
        // window would make a 6-digit code trivially brute-forceable.
        const limit = rateLimit(`2fa:${user.id}`, 8, 10 * 60_000);
        if (!limit.allowed) return tooManyAttempts(limit.retryAfterSec);

        const failure = await checkSecondFactor(user, code);
        if (failure) return Response.json({ error: failure }, { status: 401 });
        clearRateLimit(`2fa:${user.id}`);

        return loginResponse(user, { success: true, user: { id: user.id, username: user.username } }, req);
      } catch (err: any) {
        console.error("2fa verify error:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Re-send an email 2FA code mid-login (challenge proves the password step).
    "/api/auth/2fa/resend": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const { challenge } = await req.json();
        const payload = await verifyTwoFactorChallengeToken(challenge || "");
        if (!payload) return Response.json({ error: "This sign-in attempt expired — start again" }, { status: 401 });
        const user = await dbAdapter.getUser(payload.userId);
        if (!user || user.twofaMethod !== "email") return Response.json({ error: "Not applicable" }, { status: 400 });
        await issueEmailOtp(user);
        return Response.json({ success: true });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    "/api/auth/email/resend": async req => {
      try {
        const { email } = await req.json().catch(() => ({}));
        const user = await dbAdapter.getUserByEmail((email || "").trim().toLowerCase());
        if (user && !user.emailVerified && emailEnabled) {
          const token = await createEmailActionToken({ purpose: "verify", userId: user.id }, "24h");
          await sendVerificationEmail(user.email!, `${getRpIdAndOrigin(req).origin}/api/auth/email/verify?token=${encodeURIComponent(token)}`);
        }
        return Response.json({ success: true });
      } catch {
        return Response.json({ success: true });
      }
    },

    "/api/auth/email/forgot": async req => {
      try {
        const { email } = await req.json().catch(() => ({}));
        const user = await dbAdapter.getUserByEmail((email || "").trim().toLowerCase());
        // Always return success (no account enumeration).
        if (user && user.passwordHash && emailEnabled) {
          const token = await createEmailActionToken({ purpose: "reset", userId: user.id }, "1h");
          await sendPasswordResetEmail(user.email!, `${getRpIdAndOrigin(req).origin}/?reset=${encodeURIComponent(token)}`);
        }
        return Response.json({ success: true });
      } catch {
        return Response.json({ success: true });
      }
    },

    "/api/auth/email/reset": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const { token, password } = await req.json();
        const payload = await verifyEmailActionToken(token || "", "reset");
        if (!payload) return Response.json({ error: "Invalid or expired reset link" }, { status: 400 });
        if ((password || "").length < 8) return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
        const hash = await Bun.password.hash(password);
        await dbAdapter.setPassword(payload.userId, hash);
        await dbAdapter.setEmailVerified(payload.userId, true);
        const user = await dbAdapter.getUser(payload.userId);
        if (!user) return Response.json({ error: "User not found" }, { status: 404 });
        return loginResponse(user, { success: true, user: { id: user.id, username: user.username } }, req);
      } catch (err: any) {
        console.error("email reset error:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // --- Account linking (logged-in user adds another login method) ---

    // Add email + password to the current account (or change the password).
    "/api/user/set-password": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromSession(req);
        if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const { email, password } = await req.json();
        if ((password || "").length < 8) return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });

        const hash = await Bun.password.hash(password);
        let needsVerification = false;

        if (!user.email) {
          const e = (email || "").trim().toLowerCase();
          if (!EMAIL_RE.test(e)) return Response.json({ error: "Enter a valid email address" }, { status: 400 });
          const taken = await dbAdapter.getUserByEmail(e);
          if (taken && taken.id !== user.id) return Response.json({ error: "Email already in use" }, { status: 400 });
          await dbAdapter.setEmail(user.id, e);
          await dbAdapter.setPassword(user.id, hash);
          if (emailEnabled) {
            await dbAdapter.setEmailVerified(user.id, false);
            const token = await createEmailActionToken({ purpose: "verify", userId: user.id }, "24h");
            await sendVerificationEmail(e, `${getRpIdAndOrigin(req).origin}/api/auth/email/verify?token=${encodeURIComponent(token)}`);
            needsVerification = true;
          } else {
            await dbAdapter.setEmailVerified(user.id, true);
          }
        } else {
          // Already has an email — just (re)set the password.
          await dbAdapter.setPassword(user.id, hash);
        }
        return Response.json({ success: true, needsVerification });
      } catch (err: any) {
        console.error("set-password error:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Add a passkey to the current account — registration options.
    // --- Two-factor management (signed-in user) ----------------------------

    // Begin TOTP enrolment: mint a secret and return it plus a QR to scan. The
    // secret is stored but stays inactive until a code confirms it below, so an
    // abandoned setup can never lock anyone out.
    "/api/user/2fa/totp/setup": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromSession(req);
        if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (!user.passwordHash) {
          return Response.json({ error: "Two-factor applies to password logins; your account uses a passkey" }, { status: 400 });
        }
        const secret = generateTotpSecret();
        // Keep any existing method active until the new one is confirmed.
        await dbAdapter.setTwoFactor(user.id, {
          method: (user.twofaMethod as any) ?? null,
          totpSecret: secret,
          backupCodes: user.backupCodes ? JSON.parse(user.backupCodes) : null,
        });
        const url = otpauthUrl(secret, user.email || user.username);
        const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, width: 200 });
        return Response.json({ secret, formatted: formatSecretForDisplay(secret), otpauthUrl: url, qrSvg });
      } catch (err: any) {
        console.error("totp setup error:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Confirm the authenticator works, activate TOTP, and issue recovery codes.
    "/api/user/2fa/totp/enable": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromSession(req);
        if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (!user.totpSecret) return Response.json({ error: "Start setup first" }, { status: 400 });
        const { code } = await req.json();
        if (!verifyTotp(user.totpSecret, (code || "").trim())) {
          return Response.json({ error: "That code isn't right — check your authenticator app" }, { status: 400 });
        }
        const codes = generateBackupCodes(10);
        await dbAdapter.setTwoFactor(user.id, {
          method: "totp",
          totpSecret: user.totpSecret,
          backupCodes: codes.map(hashBackupCode),
        });
        // Plaintext codes are returned exactly once and never stored.
        return Response.json({ success: true, backupCodes: codes });
      } catch (err: any) {
        console.error("totp enable error:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Enable the email method by proving receipt of a code (same as sign-in).
    "/api/user/2fa/email/start": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromSession(req);
        if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (!user.passwordHash) {
          return Response.json({ error: "Two-factor applies to password logins; your account uses a passkey" }, { status: 400 });
        }
        if (!emailEnabled) return Response.json({ error: "Email delivery isn't configured on this server" }, { status: 400 });
        if (!user.email) return Response.json({ error: "Add an email address first" }, { status: 400 });
        await issueEmailOtp(user);
        return Response.json({ success: true, sentTo: user.email });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    "/api/user/2fa/email/enable": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromSession(req);
        if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const { code } = await req.json();
        const pending = await dbAdapter.getPendingOtp(user.id);
        if (!pending || pending.expiresAt < Date.now()) {
          return Response.json({ error: "That code has expired — send a new one" }, { status: 400 });
        }
        if (pending.attempts >= OTP_MAX_ATTEMPTS) {
          await dbAdapter.clearPendingOtp(user.id);
          return Response.json({ error: "Too many attempts — send a new code" }, { status: 429 });
        }
        if (pending.codeHash !== hashBackupCode((code || "").trim())) {
          await dbAdapter.bumpOtpAttempts(user.id);
          return Response.json({ error: "That code isn't right — check your email" }, { status: 400 });
        }
        await dbAdapter.clearPendingOtp(user.id);
        const codes = generateBackupCodes(10);
        await dbAdapter.setTwoFactor(user.id, { method: "email", totpSecret: null, backupCodes: codes.map(hashBackupCode) });
        return Response.json({ success: true, backupCodes: codes });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Turning 2FA off is a security downgrade, so require the password again.
    "/api/user/2fa/disable": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromSession(req);
        if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const { password } = await req.json();
        if (!user.passwordHash || !(await Bun.password.verify(password || "", user.passwordHash))) {
          return Response.json({ error: "Password is incorrect" }, { status: 401 });
        }
        await dbAdapter.setTwoFactor(user.id, { method: null, totpSecret: null, backupCodes: null });
        await dbAdapter.clearPendingOtp(user.id);
        return Response.json({ success: true });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Replace recovery codes (invalidates the old set).
    "/api/user/2fa/backup-codes": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromSession(req);
        if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (!user.twofaMethod) return Response.json({ error: "Two-factor is not enabled" }, { status: 400 });
        const { password } = await req.json();
        if (!user.passwordHash || !(await Bun.password.verify(password || "", user.passwordHash))) {
          return Response.json({ error: "Password is incorrect" }, { status: 401 });
        }
        const codes = generateBackupCodes(10);
        await dbAdapter.setBackupCodes(user.id, codes.map(hashBackupCode));
        return Response.json({ success: true, backupCodes: codes });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // --- Onboarding --------------------------------------------------------
    // Stored server-side so the flow doesn't reappear on every new device, and
    // so "replay onboarding" from Settings works the same way everywhere.
    "/api/user/onboarded": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromSession(req);
        if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const { done } = await req.json().catch(() => ({ done: true }));
        await dbAdapter.setOnboardedAt(user.id, done === false ? null : Date.now());
        return Response.json({ success: true });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    "/api/auth/passkey/add/options": async req => {
      try {
        const user = await userFromSession(req);
        if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const { rpId } = getRpIdAndOrigin(req);
        const creds = await dbAdapter.getUserCredentials(user.id);
        const options = await generateRegistrationOptions({
          rpName: RP_NAME,
          rpID: rpId,
          userID: new TextEncoder().encode(user.id),
          userName: user.username,
          userDisplayName: user.username,
          attestationType: "none",
          authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
          excludeCredentials: creds.map(c => ({ id: c.id, transports: c.transports as any })),
        });
        const challengeToken = await createChallengeToken({ challenge: options.challenge, username: user.username, userId: user.id });
        return new Response(JSON.stringify(options), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": serializeCookie("challenge_token", challengeToken, { httpOnly: true, secure: isHttps(req), sameSite: "Lax", path: "/", maxAge: 300 }),
          },
        });
      } catch (err: any) {
        console.error("passkey add options error:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Add a passkey to the current account — verify + attach.
    "/api/auth/passkey/add/verify": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromSession(req);
        if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

        const registrationResponse = await req.json();
        const cookies = parseCookies(req.headers.get("cookie"));
        const storedData = await verifyChallengeToken(cookies["challenge_token"] || "");
        if (!storedData || storedData.userId !== user.id) {
          return Response.json({ error: "Challenge expired or invalid" }, { status: 400 });
        }

        const { rpId, origin } = getRpIdAndOrigin(req);
        const verification = await verifyRegistrationResponse({
          response: registrationResponse,
          expectedChallenge: storedData.challenge,
          expectedOrigin: origin,
          expectedRPID: rpId,
        });
        if (!verification.verified || !verification.registrationInfo) {
          return Response.json({ error: "Verification failed" }, { status: 400 });
        }

        const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verification.registrationInfo;
        const base64PublicKey = Buffer.from(credential.publicKey).toString("base64url");
        const base64CredentialID = typeof credential.id === "string" ? credential.id : Buffer.from(credential.id).toString("base64url");

        await dbAdapter.saveCredential(user.id, {
          id: base64CredentialID,
          userId: user.id,
          publicKey: base64PublicKey,
          counter: credential.counter,
          backedUp: credentialBackedUp ? 1 : 0,
          deviceType: credentialDeviceType,
          transports: credential.transports || ["internal"],
          aaguid: aaguid || "",
          name: registrationResponse.authenticatorAttachment || "authenticator",
        });

        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": serializeCookie("challenge_token", "", { httpOnly: true, secure: isHttps(req), sameSite: "Lax", path: "/", maxAge: 0 }),
          },
        });
      } catch (err: any) {
        console.error("passkey add verify error:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Log out user
    "/api/auth/logout": async req => {
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": serializeCookie("session", "", {
            httpOnly: true,
            secure: isHttps(req),
            sameSite: "Lax",
            path: "/",
            maxAge: 0,
          }),
        },
      });
    },

    // WebAuthn Registration - Step 1: Options
    "/api/auth/register/options": async req => {
      try {
        if (req.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const { username, acceptedTerms, datasetConsent, showInLeaderboard } = await req.json();
        if (!username || username.trim().length < 3) {
          return Response.json({ error: "Username must be at least 3 characters" }, { status: 400 });
        }
        if (acceptedTerms !== true) {
          return Response.json({ error: "You must accept the Terms of Service and Privacy Policy" }, { status: 400 });
        }

        // Check if user already exists
        const existingUser = await dbAdapter.getUserByUsername(username);
        if (existingUser) {
          return Response.json({ error: "Username already registered" }, { status: 400 });
        }

        const userId = crypto.randomUUID();
        const { rpId } = getRpIdAndOrigin(req);

        // Get user's existing credentials to exclude
        const options = await generateRegistrationOptions({
          rpName: RP_NAME,
          rpID: rpId,
          userID: new TextEncoder().encode(userId),
          userName: username,
          userDisplayName: username,
          attestationType: "none",
          authenticatorSelection: {
            residentKey: "required",
            requireResidentKey: true,
            userVerification: "preferred",
          },
        });

        // Set challenge token in cookie (valid for 5m)
        const challengeToken = await createChallengeToken({
          challenge: options.challenge,
          username,
          userId,
          acceptedTerms: true,
          datasetConsent: datasetConsent === true,
          showInLeaderboard: showInLeaderboard === true,
        });

        return new Response(JSON.stringify(options), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": serializeCookie("challenge_token", challengeToken, {
              httpOnly: true,
              secure: isHttps(req),
              sameSite: "Lax",
              path: "/",
              maxAge: 300, // 5 minutes
            }),
          },
        });
      } catch (err: any) {
        console.error("Error generating registration options:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // WebAuthn Registration - Step 2: Verify
    "/api/auth/register/verify": async req => {
      try {
        if (req.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const registrationResponse = await req.json();
        const cookies = parseCookies(req.headers.get("cookie"));
        const challengeToken = cookies["challenge_token"];

        if (!challengeToken) {
          return Response.json({ error: "Missing challenge cookie" }, { status: 400 });
        }

        const storedData = await verifyChallengeToken(challengeToken);
        if (!storedData) {
          return Response.json({ error: "Challenge expired or invalid" }, { status: 400 });
        }

        const { rpId, origin } = getRpIdAndOrigin(req);
        const verification = await verifyRegistrationResponse({
          response: registrationResponse,
          expectedChallenge: storedData.challenge,
          expectedOrigin: origin,
          expectedRPID: rpId,
        });

        console.log("DEBUG verification:", JSON.stringify(verification, (k, v) => {
          if (v && v.type === "Buffer") return "[Buffer]";
          if (v instanceof Uint8Array) return "[Uint8Array]";
          return v;
        }, 2));

        if (verification.registrationInfo) {
          console.log("DEBUG registrationInfo keys:", Object.keys(verification.registrationInfo));
          if (verification.registrationInfo.credential) {
            console.log("DEBUG credential keys:", Object.keys(verification.registrationInfo.credential));
            console.log("DEBUG credential.publicKey type:", typeof verification.registrationInfo.credential.publicKey);
          }
        }

        if (!verification.verified || !verification.registrationInfo) {
          return Response.json({ error: "Verification failed" }, { status: 400 });
        }

        // Register user and credential in database
        const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
          verification.registrationInfo;

        const username = storedData.username!;
        const userId = storedData.userId!;

        // Consent travelled inside the signed challenge (see /register/options),
        // so a client cannot reach account creation without it.
        if (storedData.acceptedTerms !== true) {
          return Response.json({ error: "You must accept the Terms of Service and Privacy Policy" }, { status: 400 });
        }

        // 1. Create / retrieve user
        let user = await dbAdapter.getUserByUsername(username);
        const isNewUser = !user;
        if (!user) {
          await dbAdapter.createUser(username);
          user = await dbAdapter.getUserByUsername(username);
        }

        if (!user) {
          return Response.json({ error: "Failed to create user record" }, { status: 500 });
        }

        if (isNewUser) {
          await recordSignupConsent(
            user.id,
            storedData.datasetConsent === true,
            storedData.showInLeaderboard === true
          );
        }

        // 2. Save credential
        const base64PublicKey = Buffer.from(credential.publicKey).toString("base64url");
        
        let base64CredentialID = "";
        if (typeof credential.id === "string") {
          base64CredentialID = credential.id;
        } else {
          base64CredentialID = Buffer.from(credential.id).toString("base64url");
        }

        await dbAdapter.saveCredential(user.id, {
          id: base64CredentialID,
          userId: user.id,
          publicKey: base64PublicKey,
          counter: credential.counter,
          backedUp: credentialBackedUp ? 1 : 0,
          deviceType: credentialDeviceType,
          transports: credential.transports || ["internal"],
          aaguid: aaguid || "",
          name: registrationResponse.authenticatorAttachment || "authenticator",
        });

        // 3. Create active login session
        const sessionToken = await createSessionToken({
          userId: user.id,
          username: user.username,
        });

        const headers = new Headers();
        headers.append("Content-Type", "application/json");
        headers.append("Set-Cookie", serializeCookie("session", sessionToken, {
          httpOnly: true,
          secure: isHttps(req),
          sameSite: "Lax",
          path: "/",
          maxAge: 7 * 24 * 3600, // 7 days
        }));
        headers.append("Set-Cookie", serializeCookie("challenge_token", "", {
          httpOnly: true,
          secure: isHttps(req),
          sameSite: "Lax",
          path: "/",
          maxAge: 0,
        }));

        return new Response(
          JSON.stringify({ verified: true, user: { id: user.id, username: user.username } }),
          { headers }
        );
      } catch (err: any) {
        console.error("Error verifying registration:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // WebAuthn Login - Step 1: Options
    "/api/auth/login/options": async req => {
      try {
        const { rpId } = getRpIdAndOrigin(req);
        const options = await generateAuthenticationOptions({
          rpID: rpId,
          userVerification: "preferred",
        });

        const challengeToken = await createChallengeToken({
          challenge: options.challenge,
        });

        return new Response(JSON.stringify(options), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": serializeCookie("challenge_token", challengeToken, {
              httpOnly: true,
              secure: isHttps(req),
              sameSite: "Lax",
              path: "/",
              maxAge: 300, // 5 minutes
            }),
          },
        });
      } catch (err: any) {
        console.error("Error generating login options:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // WebAuthn Login - Step 2: Verify
    "/api/auth/login/verify": async req => {
      try {
        if (req.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const credential = await req.json();
        const cookies = parseCookies(req.headers.get("cookie"));
        const challengeToken = cookies["challenge_token"];

        if (!challengeToken) {
          return Response.json({ error: "Missing challenge cookie" }, { status: 400 });
        }

        const storedData = await verifyChallengeToken(challengeToken);
        if (!storedData) {
          return Response.json({ error: "Challenge expired or invalid" }, { status: 400 });
        }

        // Look up credential in DB
        const storedCred = await dbAdapter.getCredential(credential.id);
        if (!storedCred) {
          return Response.json({ error: "Credential not found" }, { status: 404 });
        }

        const user = await dbAdapter.getUser(storedCred.userId);
        if (!user) {
          return Response.json({ error: "Associated user not found" }, { status: 404 });
        }

        const { rpId, origin } = getRpIdAndOrigin(req);
        const verification = await verifyAuthenticationResponse({
          response: credential,
          expectedChallenge: storedData.challenge,
          expectedOrigin: origin,
          expectedRPID: rpId,
          credential: {
            id: storedCred.id,
            publicKey: Buffer.from(storedCred.publicKey, "base64url"),
            counter: storedCred.counter,
            transports: storedCred.transports as any,
          },
        });

        if (!verification.verified) {
          return Response.json({ error: "Invalid credential signature" }, { status: 400 });
        }

        // Update authenticator sign-in counter
        await dbAdapter.updateCredentialCounter(
          storedCred.id,
          verification.authenticationInfo.newCounter
        );

        // Establish session
        const sessionToken = await createSessionToken({
          userId: user.id,
          username: user.username,
        });

        const headers = new Headers();
        headers.append("Content-Type", "application/json");
        headers.append("Set-Cookie", serializeCookie("session", sessionToken, {
          httpOnly: true,
          secure: isHttps(req),
          sameSite: "Lax",
          path: "/",
          maxAge: 7 * 24 * 3600, // 7 days
        }));
        headers.append("Set-Cookie", serializeCookie("challenge_token", "", {
          httpOnly: true,
          secure: isHttps(req),
          sameSite: "Lax",
          path: "/",
          maxAge: 0,
        }));

        return new Response(JSON.stringify({ verified: true, user }), { headers });
      } catch (err: any) {
        console.error("Error verifying login:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Erasure (GDPR Art. 17), self-service. Two scopes:
    //   scope=traces  — every interaction, account kept
    //   scope=account — the above, plus the account and all credentials
    // Interaction data lives in the Go backend, so both scopes go there first:
    // deleting the account row while its logs survive would orphan data that
    // nobody can then reach or remove.
    "/api/user/delete": async req => {
      try {
        if (req.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const payload = await verifySessionToken(sessionToken);
        if (!payload) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }

        const { scope, confirm } = await req.json();
        if (scope !== "traces" && scope !== "account") {
          return Response.json({ error: "Unknown delete scope" }, { status: 400 });
        }

        const user = await dbAdapter.getUser(payload.userId);
        if (!user) return Response.json({ error: "User not found" }, { status: 404 });

        // Typed confirmation, checked server-side as well as in the dialog —
        // an irreversible destructive call should not be one stray fetch away.
        if (confirm !== user.username) {
          return Response.json({ error: "Confirmation did not match your username" }, { status: 400 });
        }

        const res = await fetch(`${BACKEND_URL}/api/logs/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, all: true }),
        });
        if (!res.ok) {
          // Stop here on the account path: erase the data first, or not at all.
          throw new Error(`Backend refused to delete interaction data (${res.status})`);
        }
        const { deleted = 0 } = await res.json().catch(() => ({ deleted: 0 }));

        if (scope === "traces") {
          console.log(`Deleted ${deleted} interaction row(s) for user=${user.id} (data only)`);
          return Response.json({ success: true, deleted });
        }

        await dbAdapter.deleteUser(user.id);
        console.log(`Deleted account ${user.id} and ${deleted} interaction row(s)`);

        // Clear the session: the account behind it no longer exists.
        return new Response(JSON.stringify({ success: true, deleted, accountDeleted: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": serializeCookie("session", "", {
              httpOnly: true,
              secure: isHttps(req),
              sameSite: "Lax",
              path: "/",
              maxAge: 0,
            }),
          },
        });
      } catch (err: any) {
        console.error("Error deleting user data:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Grant or withdraw dataset-release consent. Withdrawal must be as easy as
    // giving it (GDPR Art. 7(3)), so this is the same one-click call either way.
    "/api/user/consent": async req => {
      try {
        if (req.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const payload = await verifySessionToken(sessionToken);
        if (!payload) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }

        const { kind, granted } = await req.json();
        if (kind !== "dataset" && kind !== "terms") {
          return Response.json({ error: "Unknown consent kind" }, { status: 400 });
        }
        // Terms acceptance can only be re-affirmed, never revoked in place —
        // an account without accepted terms is closed, not downgraded.
        if (kind === "terms" && granted !== true) {
          return Response.json(
            { error: "To withdraw from the terms, request account deletion at contact@laion.ai" },
            { status: 400 }
          );
        }

        const version = kind === "terms" ? TERMS_VERSION : DATASET_CONSENT_VERSION;
        const source = kind === "terms" ? "re-accept" : "settings";
        await dbAdapter.recordConsent(payload.userId, kind, granted === true, version, source);

        const user = await dbAdapter.getUser(payload.userId);
        return Response.json({ success: true, user: clientUser(user) });
      } catch (err: any) {
        console.error("Error recording consent:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Fetch models list from custom endpoint
    "/api/user/byoe/models": async req => {
      try {
        if (req.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const payload = await verifySessionToken(sessionToken);
        if (!payload) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }

        let { byoeUrl, byoeKey } = await req.json();
        if (!byoeUrl) {
          return Response.json({ error: "API Base URL is required" }, { status: 400 });
        }

        const list = await resolveModelList(byoeUrl, byoeKey);
        return Response.json({ data: list.map(id => ({ id })) });
      } catch (err: any) {
        console.error("Error fetching remote models:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Update BYOE settings
    "/api/user/byoe": async req => {
      try {
        if (req.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const payload = await verifySessionToken(sessionToken);
        if (!payload) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }

        const { byoeUrl, byoeKey, byoeModel } = await req.json();

        await dbAdapter.updateBYOE(payload.userId, byoeUrl || null, byoeKey || null, byoeModel || null);

        const updatedUser = await dbAdapter.getUser(payload.userId);
        return Response.json({ success: true, user: clientUser(updatedUser) });
      } catch (err: any) {
        console.error("Error updating BYOE settings:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Update leaderboard visibility preference
    "/api/user/leaderboard": async req => {
      try {
        if (req.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const payload = await verifySessionToken(sessionToken);
        if (!payload) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }

        const { show } = await req.json();
        await dbAdapter.updateShowInLeaderboard(payload.userId, !!show);
        const updatedUser = await dbAdapter.getUser(payload.userId);
        return Response.json({ success: true, user: clientUser(updatedUser) });
      } catch (err: any) {
        console.error("Error updating leaderboard preference:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Public leaderboard — merges Go backend stats with user-DB opt-in filter
    "/api/leaderboard": async req => {
      try {
        // 1. Get aggregated stats from Go backend
        const {
          entries: statsEntries,
          tokens: globalTokens,
          traces: globalTraces,
          contributors: globalContributors,
        } = await fetchContributionStats();

        // 2. Get all users who opted in to leaderboard
        const allUsers = await db.select().from(users).all();
        const optedIn = new Map<string, string>();
        for (const u of allUsers) {
          if (u.showInLeaderboard === 1) {
            optedIn.set(u.id, u.username);
          }
        }

        // 3. Merge: only include users who opted in
        const leaderboard = statsEntries
          .filter(e => optedIn.has(e.userId))
          .map(e => ({
            username: optedIn.get(e.userId) || "Unknown",
            totalTokens: e.totalTokens,
            totalTraces: e.totalTraces,
          }));

        return Response.json({ leaderboard, globalTokens, globalTraces, globalContributors });
      } catch (err: any) {
        console.error("Error building leaderboard:", err);
        return Response.json({ error: err.message, leaderboard: [], globalTokens: 0, globalTraces: 0, globalContributors: 0 }, { status: 200 });
      }
    },

    // Shields.io endpoint badges for the README (schemaVersion 1). Public by
    // design — these are the same global totals the leaderboard already shows,
    // aggregated across all users, with no per-user attribution.
    "/api/stats/badge/:metric": async req => {
      const metric = req.params.metric;
      // One colour per metric so the badge row reads as distinct values rather
      // than a wall of blue. Shields takes the colour from this response.
      const badges: Record<string, { label: string; color: string }> = {
        contributors: { label: "contributors", color: "14b8a6" },
        traces: { label: "traces", color: "f59e0b" },
        tokens: { label: "tokens", color: "10b981" },
      };
      const badge = badges[metric];
      if (!badge) {
        return Response.json({ error: "Unknown metric" }, { status: 404 });
      }

      // Shields caches on its own, but a bad upstream shouldn't break the badge:
      // fall back to a grey "unavailable" rather than an error status.
      let message = "unavailable";
      let color = "lightgrey";
      try {
        const stats = await fetchContributionStats();
        message = formatCount(stats[metric as "tokens" | "traces" | "contributors"]);
        color = badge.color;
      } catch (err: any) {
        console.error(`Error building ${metric} badge:`, err);
      }

      return Response.json(
        { schemaVersion: 1, label: badge.label, message, color, cacheSeconds: 900 },
        { headers: { "Cache-Control": "public, max-age=900" } }
      );
    },

    // Admin: List all users
    // Dataset export (admin). Streams the backend's consent-filtered JSONL
    // straight through: this layer authenticates and names the consent version
    // it is releasing under, and the backend decides what that version permits.
    // Nothing here can widen the selection.
    "/api/admin/export": async req => {
      try {
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const payload = await verifySessionToken(sessionToken);
        if (!payload) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }
        const user = await dbAdapter.getUser(payload.userId);
        if (!user || user.isAdmin !== 1) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        const res = await fetch(
          `${BACKEND_URL}/api/export?consentVersion=${encodeURIComponent(DATASET_CONSENT_VERSION)}`
        );
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`Backend export failed (${res.status}) ${detail}`.trim());
        }

        const rows = res.headers.get("X-Export-Rows") || "0";
        console.log(`Admin ${user.username} exported ${rows} row(s) at consent version ${DATASET_CONSENT_VERSION}`);
        return new Response(res.body, {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Content-Disposition": `attachment; filename="oa2-export-v${DATASET_CONSENT_VERSION}.jsonl"`,
            "X-Export-Rows": rows,
          },
        });
      } catch (err: any) {
        console.error("Error exporting dataset:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    "/api/admin/users": async req => {
      try {
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const payload = await verifySessionToken(sessionToken);
        if (!payload) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }

        const user = await dbAdapter.getUser(payload.userId);
        if (!user || user.isAdmin !== 1) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        const allUsers = await db.select().from(users).all();
        const sanitizedUsers = allUsers.map(u => ({
          id: u.id,
          username: u.username,
          email: u.email,
          credits: u.credits,
          byoeUrl: u.byoeUrl,
          byoeModel: u.byoeModel,
          isAdmin: u.isAdmin,
          createdAt: u.createdAt,
        }));

        return Response.json({ users: sanitizedUsers });
      } catch (err: any) {
        console.error("Error fetching admin users:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Admin: List all logs from backend proxy
    "/api/admin/logs": async req => {
      try {
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const payload = await verifySessionToken(sessionToken);
        if (!payload) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }

        const user = await dbAdapter.getUser(payload.userId);
        if (!user || user.isAdmin !== 1) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        // Forward pagination + category filters to the Go backend.
        const src = new URL(req.url).searchParams;
        const qs = new URLSearchParams();
        for (const k of ["category", "limit", "offset"]) {
          const v = src.get(k);
          if (v) qs.set(k, v);
        }
        const response = await fetch(`${BACKEND_URL}/api/logs?${qs.toString()}`);
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Go backend returned error: ${errText}`);
        }

        // Go returns { logs, total, limit, offset }.
        return Response.json(await response.json());
      } catch (err: any) {
        console.error("Error fetching admin logs:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Current user's own conversation history (from the Go backend logs)
    "/api/chat/history": async req => {
      try {
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const payload = await verifySessionToken(sessionToken);
        if (!payload) {
          return Response.json({ error: "Invalid session" }, { status: 401 });
        }

        const response = await fetch(`${BACKEND_URL}/api/logs?userId=${encodeURIComponent(payload.userId)}`);
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Go backend returned error: ${errText}`);
        }
        const data = await response.json();
        return Response.json({ logs: data.logs || [] });
      } catch (err: any) {
        console.error("Error fetching chat history:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // List available models for the logged-in user's configured endpoint
    "/api/models": async req => {
      try {
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const payload = await verifySessionToken(sessionToken);
        if (!payload) return Response.json({ error: "Invalid session" }, { status: 401 });
        const user = await dbAdapter.getUser(payload.userId);
        if (!user) return Response.json({ error: "User not found" }, { status: 404 });

        if (!user.byoeUrl) {
          // No custom endpoint — offer the platform default.
          return Response.json({ models: ["gpt-4o"], default: user.byoeModel || "gpt-4o" });
        }
        const models = await resolveModelList(user.byoeUrl, user.byoeKey);
        return Response.json({ models, default: user.byoeModel || models[0] || "" });
      } catch (err: any) {
        console.error("Error listing models:", err);
        return Response.json({ error: err.message, models: [] }, { status: 200 });
      }
    },

    // Generate or revoke the user's data-collection proxy API key
    "/api/user/apikey": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const payload = await verifySessionToken(sessionToken);
        if (!payload) return Response.json({ error: "Invalid session" }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        if (body?.revoke) {
          await dbAdapter.setApiKey(payload.userId, null);
          return Response.json({ apiKey: null });
        }
        // Generate a fresh opaque key. Only its hash is stored; the plaintext is
        // returned here once and can never be retrieved again.
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        const apiKey = "oa-" + Buffer.from(bytes).toString("base64url");
        await dbAdapter.setApiKey(payload.userId, hashApiKey(apiKey));
        return Response.json({ apiKey });
      } catch (err: any) {
        console.error("Error updating API key:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Parse an uploaded OpenCode SQLite db (+ optional WAL) into trace previews.
    "/api/traces/parse-db": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const payload = await verifySessionToken(sessionToken);
        if (!payload) return Response.json({ error: "Invalid session" }, { status: 401 });

        const form = await req.formData();
        const dbFile = form.get("db");
        if (!(dbFile instanceof File)) return Response.json({ error: "No db file" }, { status: 400 });

        const dir = mkdtempSync(join(tmpdir(), "oa-oc-"));
        try {
          const base = join(dir, "opencode.db");
          writeFileSync(base, Buffer.from(await dbFile.arrayBuffer()));
          // SQLite applies a sibling WAL automatically if present (recent writes).
          const wal = form.get("wal");
          const shm = form.get("shm");
          if (wal instanceof File) writeFileSync(base + "-wal", Buffer.from(await wal.arrayBuffer()));
          if (shm instanceof File) writeFileSync(base + "-shm", Buffer.from(await shm.arrayBuffer()));
          const traces = parseSqliteDb(base);
          return Response.json({ traces });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch (err: any) {
        console.error("Error parsing opencode db:", err);
        return Response.json({ error: err.message, traces: [] }, { status: 200 });
      }
    },

    // Ingest user-selected agent traces (Claude Code / VS Code sessions) as
    // logged conversations so they show up under "My Uploads".
    "/api/traces/upload": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        
        let user = null;
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (sessionToken) {
          const payload = await verifySessionToken(sessionToken);
          if (payload) {
            user = await dbAdapter.getUser(payload.userId);
          }
        }
        if (!user) {
          user = await userFromApiKey(req);
        }
        if (!user) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const traces: any[] = Array.isArray(body?.traces) ? body.traces : [];
        if (traces.length === 0) return Response.json({ error: "No traces provided" }, { status: 400 });

        let saved = 0;
        for (const tr of traces) {
          const messages: any[] = Array.isArray(tr?.messages) ? tr.messages : [];
          if (messages.length === 0) continue;

          const { prompt, response, tokens } = buildStoredPayload(tr.model, messages, sanitizeSource(tr.source));

          // Mark uploads with a `trace:` prefix so they're distinguishable from
          // live V1-proxy sessions of the same tool (e.g. trace:claude-code).
          // Exception: pip-library sends pre-processed live proxy sessions — keep
          // that marker as-is so it gets its own filter tab in the UI.
          const detected = (tr.platform || "trace").toString();
          const platform = (
            detected === "pip-library" || detected.startsWith("pip-library") || detected.startsWith("trace")
              ? detected
              : `trace:${detected}`
          ).slice(0, 40);

          // A stable conversation id (e.g. from the pip proxy) lets the backend
          // upsert multi-turn sessions into one row instead of one per turn.
          // Without one, derive it from the trace content so re-uploading the
          // same session updates the existing row instead of duplicating it.
          const conversationId = tr.conversation_id
            ? String(tr.conversation_id).slice(0, 128)
            : stableTraceId(platform, tr);

          const res = await fetch(`${BACKEND_URL}/api/log-interaction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: user.id,
              conversationId,
              platform,
              clientRedacted: tr.clientRedacted === true,
              prompt,
              response,
              tokens,
            }),
          });
          if (res.ok) saved++;
        }
        return Response.json({ saved });
      } catch (err: any) {
        console.error("Error uploading traces:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Feedback: POST to submit (logged-in user); GET to list (admin or bearer).
    "/api/feedback": async req => {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }
      try {
        if (req.method === "GET") {
          if (!(await feedbackAuthorized(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
          const status = new URL(req.url).searchParams.get("status") || "";
          const r = await fetch(`${BACKEND_URL}/api/feedback?status=${encodeURIComponent(status)}`);
          return Response.json(await r.json());
        }
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });

        // Submitting requires a logged-in user session.
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const payload = await verifySessionToken(sessionToken);
        if (!payload) return Response.json({ error: "Invalid session" }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const message = (body?.message || "").toString().trim();
        if (!message) return Response.json({ error: "Message required" }, { status: 400 });

        const r = await fetch(`${BACKEND_URL}/api/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: payload.userId,
            message: message.slice(0, 5000),
            category: (body?.category || "").toString().slice(0, 40),
          }),
        });
        if (!r.ok) throw new Error(await r.text());
        return Response.json({ success: true });
      } catch (err: any) {
        console.error("Error in /api/feedback:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Mark feedback done/open (admin or bearer) — lets an agent tick items off.
    "/api/feedback/update": async req => {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        if (!(await feedbackAuthorized(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const body = await req.json().catch(() => ({}));
        const id = Number(body?.id);
        const status = body?.status === "open" ? "open" : "done";
        if (!id) return Response.json({ error: "id required" }, { status: 400 });
        const r = await fetch(`${BACKEND_URL}/api/feedback/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, status }),
        });
        if (!r.ok) throw new Error(await r.text());
        return Response.json(await r.json());
      } catch (err: any) {
        console.error("Error in /api/feedback/update:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Persist a redacted version of a conversation (rewrites its stored content).
    "/api/chat/redact": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const payload = await verifySessionToken(sessionToken);
        if (!payload) return Response.json({ error: "Invalid session" }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const conversationId = body?.conversationId ? body.conversationId.toString() : "";
        const logId = typeof body?.logId === "number" ? body.logId : 0;
        const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
        if ((!conversationId && !logId) || messages.length === 0) {
          return Response.json({ error: "conversationId or logId, and messages required" }, { status: 400 });
        }

        // The client sends the source envelope back *redacted*. When it is
        // absent the rewritten row deliberately carries no source — preserving
        // the stored one would resurrect unredacted text.
        const { prompt, response, tokens } = buildStoredPayload(body?.model || "", messages, sanitizeSource(body?.source));
        const res = await fetch(`${BACKEND_URL}/api/logs/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: payload.userId, conversationId, logId, prompt, response, tokens }),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Go backend returned error: ${errText}`);
        }
        return Response.json(await res.json());
      } catch (err: any) {
        console.error("Error redacting conversation:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Delete one of the current user's own conversations/logs
    "/api/chat/delete": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const payload = await verifySessionToken(sessionToken);
        if (!payload) return Response.json({ error: "Invalid session" }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const response = await fetch(`${BACKEND_URL}/api/logs/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: payload.userId,
            conversationId: body?.conversationId || "",
            id: body?.id || 0,
          }),
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Go backend returned error: ${errText}`);
        }
        return Response.json(await response.json());
      } catch (err: any) {
        console.error("Error deleting logs:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Chat completions route (web UI, cookie-authenticated)
    "/api/chat": async req => {
      try {
        if (req.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const payload = await verifySessionToken(sessionToken);
        if (!payload) return Response.json({ error: "Invalid session" }, { status: 401 });
        const user = await dbAdapter.getUser(payload.userId);
        if (!user) return Response.json({ error: "User not found" }, { status: 404 });

        const reqBody = await req.json();
        return proxyChatCompletion(user, reqBody, req.headers.get("X-Conversation-Id"), "chat");
      } catch (err: any) {
        console.error("Error in /api/chat completions proxy:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // OpenAI-compatible proxy endpoint for external tools (VS Code, opencode,
    // etc.). Authenticated by the user's personal API key; every request is
    // logged for dataset collection and routed to their configured endpoint.
    "/v1/chat/completions": async req => {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromApiKey(req);
        if (!user) return Response.json({ error: "Invalid API key" }, { status: 401 });
        const reqBody = await req.json();
        // Honor a caller-supplied conversation id if present (most tools omit it).
        const conversationId = req.headers.get("X-Conversation-Id");
        return proxyChatCompletion(user, reqBody, conversationId, detectPlatform(req));
      } catch (err: any) {
        console.error("Error in /v1/chat/completions proxy:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // OpenAI-compatible model listing for external tools (API-key authed)
    "/v1/models": async req => {
      try {
        const user = await userFromApiKey(req);
        if (!user) return Response.json({ error: "Invalid API key" }, { status: 401 });
        const ids = user.byoeUrl ? await resolveModelList(user.byoeUrl, user.byoeKey) : ["gpt-4o"];
        return Response.json({
          object: "list",
          data: ids.map(id => ({ id, object: "model", owned_by: "open-assistant" })),
        });
      } catch (err: any) {
        console.error("Error in /v1/models:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // v1beta completions route
    "/v1beta/chat/completions": async req => {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const user = await userFromApiKey(req);
        if (!user) return Response.json({ error: "Invalid API key" }, { status: 401 });
        const reqBody = await req.json();
        const conversationId = req.headers.get("X-Conversation-Id");
        return proxyChatCompletion(user, reqBody, conversationId, detectPlatform(req), true);
      } catch (err: any) {
        console.error("Error in /v1beta/chat/completions proxy:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // v1beta models route
    "/v1beta/models": async req => {
      try {
        const user = await userFromApiKey(req);
        if (!user) return Response.json({ error: "Invalid API key" }, { status: 401 });
        const ids = user.byoeUrl ? await resolveModelList(user.byoeUrl, user.byoeKey) : ["gpt-4o"];
        return Response.json({
          object: "list",
          data: ids.map(id => ({ id, object: "model", owned_by: "open-assistant" })),
        });
      } catch (err: any) {
        console.error("Error in /v1beta/models:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },
  },
});

console.log(`🚀 Open Assistant 2.0 frontend server running at ${server.url}`);
