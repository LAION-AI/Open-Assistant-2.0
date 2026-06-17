import { serve } from "bun";
import dns from "dns/promises";
import net from "net";
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
} from "./lib/session";
import { parseCookies, serializeCookie } from "./lib/cookies";
import indexHtml from "./index.html";

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
  const hostname = url.hostname;

  // Check if hostname is in ALLOWED_HOSTS
  const isAllowed = ALLOWED_HOSTS.includes(hostname);
  const rpId = isAllowed ? hostname : (ALLOWED_HOSTS[0] || "localhost");

  // WebAuthn expects origin matching protocol + host (including port in development)
  const origin = `${url.protocol}//${url.host}`;
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
        url.hostname = ips[0];
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
  const modelsUrl = resolved.endsWith("/models") ? resolved : `${resolved}/models`;
  const headers: Record<string, string> = {};
  if (byoeKey && byoeKey.trim()) headers["Authorization"] = `Bearer ${byoeKey.trim()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(modelsUrl, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to fetch models: ${res.statusText}`);
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data.map((m: any) => m.id).filter(Boolean) : [];
  } finally {
    clearTimeout(timeout);
  }
}

// Shared chat-completion forwarder used by both the cookie-auth web UI and the
// API-key proxy for external tools. Resolves the model (client choice wins),
// routes through the Go logging proxy, and returns the streamed response.
async function proxyChatCompletion(
  user: any,
  reqBody: any,
  conversationId: string | null,
  platform: string,
): Promise<Response> {
  const isBYOE = !!user.byoeUrl;
  if (!isBYOE && user.credits <= 0) {
    return Response.json({ error: "Out of credits! Please configure BYOE in settings." }, { status: 402 });
  }

  // Model selection on the fly: explicit request model, else the saved default.
  const model =
    (typeof reqBody?.model === "string" && reqBody.model.trim()) || user.byoeModel || "gpt-4o";
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

  const response = await fetch(`${BACKEND_URL}/v1/chat/completions`, {
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
  return ua.split("/")[0].slice(0, 40) || "api";
}

// Resolve a user from an `Authorization: Bearer <api key>` header.
async function userFromApiKey(req: Request): Promise<any | null> {
  const auth = req.headers.get("Authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key) return null;
  return dbAdapter.getUserByApiKey(key);
}

const server = serve({
  port: PORT,
  // Chat completions can stream for a while (long reasoning); the default 10s
  // idle timeout cuts them off. Allow up to 180s of idle between chunks.
  idleTimeout: 180,
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
  routes: {
    // Serve index.html for UI pages (Single Page App routing)
    "/*": indexHtml,

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

      return Response.json({ user });
    },

    // Log out user
    "/api/auth/logout": async req => {
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": serializeCookie("session", "", {
            httpOnly: true,
            secure: false,
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
        const { username } = await req.json();
        if (!username || username.trim().length < 3) {
          return Response.json({ error: "Username must be at least 3 characters" }, { status: 400 });
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
        });

        return new Response(JSON.stringify(options), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": serializeCookie("challenge_token", challengeToken, {
              httpOnly: true,
              secure: false,
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

        // 1. Create / retrieve user
        let user = await dbAdapter.getUserByUsername(username);
        if (!user) {
          await dbAdapter.createUser(username);
          user = await dbAdapter.getUserByUsername(username);
        }

        if (!user) {
          return Response.json({ error: "Failed to create user record" }, { status: 500 });
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
          secure: false,
          path: "/",
          maxAge: 7 * 24 * 3600, // 7 days
        }));
        headers.append("Set-Cookie", serializeCookie("challenge_token", "", {
          httpOnly: true,
          secure: false,
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
              secure: false,
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
          secure: false,
          path: "/",
          maxAge: 7 * 24 * 3600, // 7 days
        }));
        headers.append("Set-Cookie", serializeCookie("challenge_token", "", {
          httpOnly: true,
          secure: false,
          path: "/",
          maxAge: 0,
        }));

        return new Response(JSON.stringify({ verified: true, user }), { headers });
      } catch (err: any) {
        console.error("Error verifying login:", err);
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

        // Clean up URL and resolve local hostname to IP if needed
        byoeUrl = byoeUrl.trim().replace(/\/$/, "");
        const resolvedByoeUrl = await resolveLocalHostIfNecessary(byoeUrl);
        const modelsUrl = resolvedByoeUrl.endsWith("/models") ? resolvedByoeUrl : `${resolvedByoeUrl}/models`;

        const headers: Record<string, string> = {};
        if (byoeKey && byoeKey.trim()) {
          headers["Authorization"] = `Bearer ${byoeKey.trim()}`;
        }

        console.log(`Fetching models list from: ${modelsUrl} (original URL: ${byoeUrl})`);
        
        // Use a short timeout to prevent hanging on unreachable local addresses
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(modelsUrl, {
          method: "GET",
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Failed to fetch models from endpoint: ${response.statusText}`);
        }

        const data = await response.json();
        return Response.json(data);
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
        return Response.json({ success: true, user: updatedUser });
      } catch (err: any) {
        console.error("Error updating BYOE settings:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Admin: List all users
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

        // Fetch logs from Go backend proxy
        const response = await fetch(`${BACKEND_URL}/api/logs`);
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Go backend returned error: ${errText}`);
        }

        const logs = await response.json();
        return Response.json({ logs });
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
        const logs = await response.json();
        return Response.json({ logs: logs || [] });
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
        // Generate a fresh opaque key.
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        const apiKey = "oa-" + Buffer.from(bytes).toString("base64url");
        await dbAdapter.setApiKey(payload.userId, apiKey);
        return Response.json({ apiKey });
      } catch (err: any) {
        console.error("Error updating API key:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },

    // Ingest user-selected agent traces (Claude Code / VS Code sessions) as
    // logged conversations so they show up under "My Uploads".
    "/api/traces/upload": async req => {
      try {
        if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
        const cookies = parseCookies(req.headers.get("cookie"));
        const sessionToken = cookies["session"];
        if (!sessionToken) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const payload = await verifySessionToken(sessionToken);
        if (!payload) return Response.json({ error: "Invalid session" }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const traces: any[] = Array.isArray(body?.traces) ? body.traces : [];
        if (traces.length === 0) return Response.json({ error: "No traces provided" }, { status: 400 });

        let saved = 0;
        for (const tr of traces) {
          const messages: any[] = Array.isArray(tr?.messages) ? tr.messages : [];
          if (messages.length === 0) continue;

          // Last assistant message becomes the logged "response"; the rest is the
          // prompt history — mirrors how live turns are stored.
          let history = messages;
          let finalAssistant: any = { role: "assistant", content: "" };
          if (messages[messages.length - 1]?.role === "assistant") {
            finalAssistant = messages[messages.length - 1];
            history = messages.slice(0, -1);
          }

          const prompt = JSON.stringify({ model: tr.model || "trace", messages: history });
          const response = JSON.stringify({
            role: "assistant",
            content: finalAssistant.content || "",
            reasoning_content: finalAssistant.reasoning || "",
            ...(finalAssistant.tool_calls ? { tool_calls: finalAssistant.tool_calls } : {}),
          });
          const tokens = Math.floor((prompt.length + response.length) / 4);

          // Mark uploads with a `trace:` prefix so they're distinguishable from
          // live V1-proxy sessions of the same tool (e.g. trace:claude-code).
          const detected = (tr.platform || "trace").toString();
          const platform = (detected.startsWith("trace") ? detected : `trace:${detected}`).slice(0, 40);

          const res = await fetch(`${BACKEND_URL}/api/log-interaction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: payload.userId,
              conversationId: crypto.randomUUID(),
              platform,
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
  },
});

console.log(`🚀 Open Assistant 2.0 frontend server running at ${server.url}`);
