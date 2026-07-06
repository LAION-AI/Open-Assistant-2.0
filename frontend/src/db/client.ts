import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { DrizzleAdapter } from "./adapters/drizzle";

const sqlite = new Database(process.env.USER_DB || "user.db");
export const db = drizzle(sqlite, { schema });

export const dbAdapter = new DrizzleAdapter(db);
