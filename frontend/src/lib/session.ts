import * as jose from "jose";

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "super_secret_open_assistant_2_token_key_1234567890"
);

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

export async function verifyEmailActionToken(token: string, purpose: "verify" | "reset") {
  try {
    const { payload } = await jose.jwtVerify(token, SECRET);
    if (payload.purpose !== purpose) return null;
    return payload as { purpose: string; userId: string };
  } catch (e) {
    return null;
  }
}
