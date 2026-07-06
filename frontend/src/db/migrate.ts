import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

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
  console.log("Migrations complete.");
}

if (require.main === module) {
  runMigrations();
}
