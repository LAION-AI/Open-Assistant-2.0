import * as jose from "jose";

// Every session and challenge token is signed with this. The development
// fallback is published in this repo, so anyone could forge a session with it —
// refuse to start in production rather than run with a known-public key.
const DEV_FALLBACK_SECRET = "super_secret_open_assistant_2_token_key_1234567890";

function resolveSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv !== DEV_FALLBACK_SECRET) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET must be set to a unique random value in production. " +
        "The built-in development key is public, so sessions signed with it are forgeable. " +
        "Generate one with: openssl rand -base64 48",
    );
  }
  console.warn("[auth] JWT_SECRET is unset — using the insecure development key. Do not use this in production.");
  return DEV_FALLBACK_SECRET;
}

const SECRET = new TextEncoder().encode(resolveSecret());

export async function createSessionToken(payload: { userId: string; username: string }) {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(SECRET);
}

export async function verifySessionToken(token: string) {
  try {
    const { payload } = await jose.jwtVerify(token, SECRET);
    return payload as { userId: string; username: string };
  } catch (e) {
    return null;
  }
}

export async function createChallengeToken(payload: {
  challenge: string;
  username?: string;
  userId?: string;
}) {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m") // Challenge is valid for 5 minutes
    .sign(SECRET);
}

export async function verifyChallengeToken(token: string) {
  try {
    const { payload } = await jose.jwtVerify(token, SECRET);
    return payload as { challenge: string; username?: string; userId?: string };
  } catch (e) {
    return null;
  }
}

// Signed, short-lived tokens for email verification ("verify") and password
// reset ("reset"). Self-contained — no DB storage needed.
export async function createEmailActionToken(
  payload: { purpose: "verify" | "reset"; userId: string },
  expiresIn: string,
) {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(SECRET);
}

// Short-lived token proving "password was correct, second factor still owed".
// Deliberately distinct from a session token so it cannot be used as one.
export async function createTwoFactorChallengeToken(payload: { userId: string; method: string }) {
  return await new jose.SignJWT({ ...payload, purpose: "2fa" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(SECRET);
}

export async function verifyTwoFactorChallengeToken(token: string) {
  try {
    const { payload } = await jose.jwtVerify(token, SECRET);
    if (payload.purpose !== "2fa") return null;
    return payload as unknown as { userId: string; method: string };
  } catch {
    return null;
  }
}

export async function verifyEmailActionToken(token: string, purpose: "verify" | "reset") {
  try {
    const { payload } = await jose.jwtVerify(token, SECRET);
    if (payload.purpose !== purpose) return null;
    return payload as { purpose: string; userId: string };
  } catch (e) {
    return null;
  }
}
