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
  // Two-factor auth. Only meaningful for password accounts — passkeys are
  // already phishing-resistant multi-factor, so 2FA is not offered for them.
  twofaMethod: text("twofa_method"), // 'totp' | 'email' | null (= disabled)
  totpSecret: text("totp_secret"), // base32; set during setup, kept for 'totp'
  backupCodes: text("backup_codes"), // JSON array of SHA-256 recovery-code hashes
  onboardedAt: integer("onboarded_at"), // null = onboarding not finished/skipped
  createdAt: integer("created_at").notNull(),
});

// Short-lived 6-digit codes for the email 2FA method. Kept server-side (rather
// than inside the signed challenge) so attempts can be counted — a 6-digit code
// held by the client would otherwise be brute-forceable offline.
export const emailOtps = sqliteTable("email_otps", {
  userId: text("user_id").primaryKey(), // one pending code per user
  codeHash: text("code_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  attempts: integer("attempts").default(0).notNull(),
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
