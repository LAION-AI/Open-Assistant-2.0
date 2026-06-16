import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

export function runMigrations() {
  console.log("Running migrations...");
  const sqlite = new Database("user.db");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "./drizzle" });
  // Additive columns for databases created before they existed. SQLite has no
  // "ADD COLUMN IF NOT EXISTS", so ignore the "duplicate column" error.
  try {
    sqlite.run("ALTER TABLE users ADD COLUMN api_key TEXT");
  } catch {}
  console.log("Migrations complete.");
}

if (require.main === module) {
  runMigrations();
}
