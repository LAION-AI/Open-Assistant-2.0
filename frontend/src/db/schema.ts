import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").unique().notNull(),
  email: text("email"),
  credits: integer("credits").default(1000).notNull(),
  byoeUrl: text("byoe_url"),
  byoeKey: text("byoe_key"),
  byoeModel: text("byoe_model"),
  apiKey: text("api_key"), // SHA-256 hash of the user's proxy key (never plaintext); shown once at creation
  passwordHash: text("password_hash"), // for email+password login (null = passkey-only)
  emailVerified: integer("email_verified").default(0).notNull(),
  showInLeaderboard: integer("show_in_leaderboard").default(1).notNull(),
  isAdmin: integer("is_admin").default(0).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(), // Base64URL-encoded credential ID
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  publicKey: text("public_key").notNull(), // Base64URL-encoded public key
  counter: integer("counter").notNull(),
  backedUp: integer("backed_up").notNull(), // 0 or 1
  deviceType: text("device_type").notNull(), // 'singleDevice' | 'multiDevice'
  transports: text("transports").notNull(), // JSON string representing transports array
  aaguid: text("aaguid").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});
