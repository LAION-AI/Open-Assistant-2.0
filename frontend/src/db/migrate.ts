import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

export function runMigrations() {
  console.log("Running migrations...");
  const sqlite = new Database("user.db");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");
}

if (require.main === module) {
  runMigrations();
}
