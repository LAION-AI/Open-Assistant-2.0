import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createHash } from "node:crypto";

export function runMigrations() {
  console.log("Running migrations...");
  const sqlite = new Database(process.env.USER_DB || "user.db");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "./drizzle" });
  // Additive columns for databases created before they existed. SQLite has no
  // "ADD COLUMN IF NOT EXISTS", so ignore the "duplicate column" error.
  try {
    sqlite.run("ALTER TABLE users ADD COLUMN api_key TEXT");
  } catch {}
  try {
    sqlite.run("ALTER TABLE users ADD COLUMN password_hash TEXT");
  } catch {}
  try {
    sqlite.run("ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0 NOT NULL");
  } catch {}
  try {
    sqlite.run("ALTER TABLE users ADD COLUMN show_in_leaderboard INTEGER DEFAULT 1 NOT NULL");
  } catch {}
  try {
    sqlite.run("ALTER TABLE users ADD COLUMN twofa_method TEXT");
  } catch {}
  try {
    sqlite.run("ALTER TABLE users ADD COLUMN totp_secret TEXT");
  } catch {}
  try {
    sqlite.run("ALTER TABLE users ADD COLUMN backup_codes TEXT");
  } catch {}
  try {
    sqlite.run("ALTER TABLE users ADD COLUMN onboarded_at INTEGER");
  } catch {}

  // Pending email 2FA codes (see schema.ts for why these live server-side).
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS email_otps (
      user_id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  // Drop anything already expired so the table can't grow unbounded.
  try {
    sqlite.run("DELETE FROM email_otps WHERE expires_at < ?", [Date.now()] as any);
  } catch {}

  // Migrate any legacy plaintext API keys to SHA-256 hashes in place, so
  // existing keys keep working after the switch to hashed storage. Legacy keys
  // start with "oa-"; already-hashed values are 64-char hex, so this is
  // idempotent and safe to run repeatedly.
  try {
    const rows = sqlite
      .query("SELECT id, api_key FROM users WHERE api_key IS NOT NULL AND api_key LIKE 'oa-%'")
      .all() as { id: string; api_key: string }[];
    const update = sqlite.query("UPDATE users SET api_key = ? WHERE id = ?");
    for (const row of rows) {
      const hash = createHash("sha256").update(row.api_key.trim()).digest("hex");
      update.run(hash, row.id);
    }
    if (rows.length) console.log(`Hashed ${rows.length} legacy API key(s).`);
  } catch (e) {
    console.error("API key hashing migration failed:", e);
  }

  console.log("Migrations complete.");
}

if (require.main === module) {
  runMigrations();
}
