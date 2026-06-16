import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { users, credentials } from "../schema";
import type { DatabaseAdapter, UserRecord, StoredCredential } from "./base";

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
}
