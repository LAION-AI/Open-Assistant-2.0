import { eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { users, credentials, emailOtps, consentEvents } from "../schema";
import type {
  DatabaseAdapter,
  UserRecord,
  StoredCredential,
  TwoFactorSettings,
  PendingOtp,
  ConsentKind,
  ConsentSource,
} from "./base";

export class DrizzleAdapter implements DatabaseAdapter {
  private db: BunSQLiteDatabase<typeof import("../schema")>;

  constructor(db: BunSQLiteDatabase<typeof import("../schema")>) {
    this.db = db;
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const res = await this.db.select().from(users).where(eq(users.id, id)).get();
    return res || null;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const res = await this.db.select().from(users).where(eq(users.username, username)).get();
    return res || null;
  }

  async getUserByApiKey(apiKey: string): Promise<UserRecord | null> {
    if (!apiKey) return null;
    const res = await this.db.select().from(users).where(eq(users.apiKey, apiKey)).get();
    return res || null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    if (!email) return null;
    // Case-insensitive email match.
    const res = await this.db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
    return res || null;
  }

  async createEmailUser(username: string, email: string, passwordHash: string): Promise<UserRecord> {
    const id = crypto.randomUUID();
    const isFirstUser = (await this.db.select().from(users).all()).length === 0;
    const isAdmin = isFirstUser ? 1 : 0;
    const newUser = {
      id,
      username,
      email: email.toLowerCase(),
      passwordHash,
      emailVerified: 0,
      credits: 1000,
      isAdmin,
      createdAt: Date.now(),
    };
    await this.db.insert(users).values(newUser).run();
    return { id, username, email: email.toLowerCase(), passwordHash, emailVerified: 0, credits: 1000, isAdmin };
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, id)).run();
  }

  async setEmail(id: string, email: string): Promise<void> {
    await this.db.update(users).set({ email: email.toLowerCase() }).where(eq(users.id, id)).run();
  }

  async setEmailVerified(id: string, verified: boolean): Promise<void> {
    await this.db.update(users).set({ emailVerified: verified ? 1 : 0 }).where(eq(users.id, id)).run();
  }

  async setApiKey(id: string, apiKey: string | null): Promise<void> {
    await this.db.update(users).set({ apiKey }).where(eq(users.id, id)).run();
  }

  async createUser(username: string): Promise<UserRecord> {
    const id = crypto.randomUUID();
    const userCountRes = await this.db.select().from(users).all();
    const isFirstUser = userCountRes.length === 0;
    const isAdmin = isFirstUser ? 1 : 0;

    const newUser = {
      id,
      username,
      credits: 1000,
      isAdmin,
      createdAt: Date.now(),
    };
    await this.db.insert(users).values(newUser).run();
    return {
      id,
      username,
      credits: 1000,
      byoeUrl: null,
      byoeKey: null,
      byoeModel: null,
      apiKey: null,
      isAdmin,
    };
  }

  async updateCredits(id: string, amount: number): Promise<void> {
    const user = await this.getUser(id);
    if (!user) throw new Error("User not found");
    const newCredits = Math.max(0, user.credits + amount);
    await this.db.update(users).set({ credits: newCredits }).where(eq(users.id, id)).run();
  }

  async updateBYOE(
    id: string,
    byoeUrl: string | null,
    byoeKey: string | null,
    byoeModel: string | null
  ): Promise<void> {
    await this.db
      .update(users)
      .set({ byoeUrl, byoeKey, byoeModel })
      .where(eq(users.id, id))
      .run();
  }

  async getUserCredentials(userId: string): Promise<StoredCredential[]> {
    const res = await this.db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, userId))
      .all();

    return res.map(c => ({
      id: c.id,
      userId: c.userId,
      publicKey: c.publicKey,
      counter: c.counter,
      backedUp: c.backedUp,
      deviceType: c.deviceType,
      transports: JSON.parse(c.transports),
      aaguid: c.aaguid,
      name: c.name,
    }));
  }

  async getCredential(id: string): Promise<StoredCredential | null> {
    const c = await this.db.select().from(credentials).where(eq(credentials.id, id)).get();
    if (!c) return null;

    return {
      id: c.id,
      userId: c.userId,
      publicKey: c.publicKey,
      counter: c.counter,
      backedUp: c.backedUp,
      deviceType: c.deviceType,
      transports: JSON.parse(c.transports),
      aaguid: c.aaguid,
      name: c.name,
    };
  }

  async saveCredential(userId: string, credential: StoredCredential): Promise<void> {
    await this.db
      .insert(credentials)
      .values({
        id: credential.id,
        userId: userId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        backedUp: credential.backedUp,
        deviceType: credential.deviceType,
        transports: JSON.stringify(credential.transports),
        aaguid: credential.aaguid,
        name: credential.name,
        createdAt: Date.now(),
      })
      .run();
  }

  async updateCredentialCounter(id: string, counter: number): Promise<void> {
    await this.db.update(credentials).set({ counter }).where(eq(credentials.id, id)).run();
  }

  async updateShowInLeaderboard(id: string, show: boolean): Promise<void> {
    await this.db.update(users).set({ showInLeaderboard: show ? 1 : 0 }).where(eq(users.id, id)).run();
  }

  async getLeaderboard(): Promise<{ username: string; totalTokens: number; totalTraces: number }[]> {
    // This method returns all users who opted-in to the leaderboard.
    // The actual token/trace counts come from the Go backend, so we just
    // return the user list here; the Bun route will merge the data.
    const res = await this.db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.showInLeaderboard, 1))
      .all();
    return res.map(u => ({ username: u.username, totalTokens: 0, totalTraces: 0 }));
  }

  // --- Two-factor auth -------------------------------------------------------

  async setTwoFactor(id: string, settings: TwoFactorSettings): Promise<void> {
    await this.db
      .update(users)
      .set({
        twofaMethod: settings.method,
        totpSecret: settings.totpSecret ?? null,
        backupCodes: settings.backupCodes ? JSON.stringify(settings.backupCodes) : null,
      })
      .where(eq(users.id, id))
      .run();
  }

  async setBackupCodes(id: string, hashes: string[]): Promise<void> {
    await this.db.update(users).set({ backupCodes: JSON.stringify(hashes) }).where(eq(users.id, id)).run();
  }

  async savePendingOtp(userId: string, codeHash: string, expiresAt: number): Promise<void> {
    // One pending code per user: a re-request replaces the previous one and
    // resets the attempt counter.
    await this.db
      .insert(emailOtps)
      .values({ userId, codeHash, expiresAt, attempts: 0, createdAt: Date.now() })
      .onConflictDoUpdate({
        target: emailOtps.userId,
        set: { codeHash, expiresAt, attempts: 0, createdAt: Date.now() },
      })
      .run();
  }

  async getPendingOtp(userId: string): Promise<PendingOtp | null> {
    const res = await this.db.select().from(emailOtps).where(eq(emailOtps.userId, userId)).get();
    return res ? { userId: res.userId, codeHash: res.codeHash, expiresAt: res.expiresAt, attempts: res.attempts } : null;
  }

  async bumpOtpAttempts(userId: string): Promise<number> {
    await this.db
      .update(emailOtps)
      .set({ attempts: sql`${emailOtps.attempts} + 1` })
      .where(eq(emailOtps.userId, userId))
      .run();
    const res = await this.db.select().from(emailOtps).where(eq(emailOtps.userId, userId)).get();
    return res?.attempts ?? 0;
  }

  async clearPendingOtp(userId: string): Promise<void> {
    await this.db.delete(emailOtps).where(eq(emailOtps.userId, userId)).run();
  }

  // --- Onboarding ------------------------------------------------------------

  async setOnboardedAt(id: string, at: number | null): Promise<void> {
    await this.db.update(users).set({ onboardedAt: at }).where(eq(users.id, id)).run();
  }

  async recordConsent(
    userId: string,
    kind: ConsentKind,
    granted: boolean,
    version: string,
    source: ConsentSource
  ): Promise<void> {
    const at = Date.now();
    await this.db
      .insert(consentEvents)
      .values({
        id: crypto.randomUUID(),
        userId,
        kind,
        granted: granted ? 1 : 0,
        version,
        source,
        createdAt: at,
      })
      .run();

    // Current state mirrors the latest event. Withdrawal keeps the timestamp
    // and version of the decision, so "declined on <date>, document v1.0" is
    // still answerable from the users row alone.
    const patch =
      kind === "terms"
        ? { termsAcceptedAt: granted ? at : null, termsVersion: granted ? version : null }
        : {
            datasetConsent: granted ? 1 : 0,
            datasetConsentAt: at,
            datasetConsentVersion: version,
          };
    await this.db.update(users).set(patch).where(eq(users.id, userId)).run();
  }
}
