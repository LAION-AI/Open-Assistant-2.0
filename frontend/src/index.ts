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

    // Chat completions route
    "/api/chat": async req => {
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

        const user = await dbAdapter.getUser(payload.userId);
        if (!user) {
          return Response.json({ error: "User not found" }, { status: 404 });
        }

        const reqBody = await req.json();

        // Check if user has a custom endpoint (key is optional for local hosts)
        const isBYOE = !!user.byoeUrl;
        if (!isBYOE && user.credits <= 0) {
          return Response.json({ error: "Out of credits! Please configure BYOE in settings." }, { status: 402 });
        }

        // Forward to the Go backend proxy for completions & logging
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-User-Id": user.id,
        };

        // Conversation id groups all turns of one chat together for logging.
        const conversationId = req.headers.get("X-Conversation-Id");
        if (conversationId) {
          headers["X-Conversation-Id"] = conversationId;
        }

        if (isBYOE) {
          // Resolve local hostnames (e.g. pizero.local) to IP addresses so that Go backend can reach it without DNS resolution failures
          const resolvedByoeUrl = await resolveLocalHostIfNecessary(user.byoeUrl!);
          headers["X-BYOE-Url"] = resolvedByoeUrl;
          if (user.byoeKey) {
            headers["X-BYOE-Key"] = user.byoeKey;
          }
          headers["X-BYOE-Model"] = user.byoeModel || "gpt-4o";
        }

        console.log(`Forwarding completions to Go proxy: user=${user.id}, BYOE=${isBYOE}`);

        const response = await fetch(`${BACKEND_URL}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(reqBody),
        });

        if (!response.ok) {
          const errText = await response.text();
          return new Response(errText, { status: response.status, headers: { "Content-Type": "text/plain" } });
        }

        if (!isBYOE) {
          await dbAdapter.updateCredits(user.id, -10);
        }

        return new Response(response.body, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      } catch (err: any) {
        console.error("Error in /api/chat completions proxy:", err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    },
  },
});

console.log(`🚀 Open Assistant 2.0 frontend server running at ${server.url}`);
