export interface UserRecord {
  id: string;
  username: string;
  email?: string | null;
  credits: number;
  byoeUrl?: string | null;
  byoeKey?: string | null;
  byoeModel?: string | null;
  apiKey?: string | null;
  passwordHash?: string | null;
  emailVerified?: number;
  showInLeaderboard?: number;
  isAdmin: number;
  twofaMethod?: string | null; // 'totp' | 'email' | null
  totpSecret?: string | null;
  backupCodes?: string | null; // JSON array of SHA-256 hashes
  onboardedAt?: number | null;
  termsAcceptedAt?: number | null;
  termsVersion?: string | null;
  datasetConsent?: number;
  datasetConsentAt?: number | null;
  datasetConsentVersion?: string | null;
}

export type ConsentKind = "terms" | "dataset";
export type ConsentSource = "signup" | "settings" | "re-accept";

export interface TwoFactorSettings {
  method: "totp" | "email" | null;
  totpSecret?: string | null;
  backupCodes?: string[] | null;
}

export interface PendingOtp {
  userId: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

export interface StoredCredential {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  backedUp: number; // 0 or 1
  deviceType: string;
  transports: string[];
  aaguid: string;
  name: string;
}

export interface DatabaseAdapter {
  getUser(id: string): Promise<UserRecord | null>;
  getUserByUsername(username: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserByApiKey(apiKey: string): Promise<UserRecord | null>;
  createUser(username: string): Promise<UserRecord>;
  createEmailUser(username: string, email: string, passwordHash: string): Promise<UserRecord>;
  setPassword(id: string, passwordHash: string): Promise<void>;
  setEmail(id: string, email: string): Promise<void>;
  setEmailVerified(id: string, verified: boolean): Promise<void>;
  setApiKey(id: string, apiKey: string | null): Promise<void>;
  updateCredits(id: string, amount: number): Promise<void>;
  updateBYOE(
    id: string,
    byoeUrl: string | null,
    byoeKey: string | null,
    byoeModel: string | null
  ): Promise<void>;
  getUserCredentials(userId: string): Promise<StoredCredential[]>;
  getCredential(id: string): Promise<StoredCredential | null>;
  saveCredential(userId: string, credential: StoredCredential): Promise<void>;
  updateCredentialCounter(id: string, counter: number): Promise<void>;
  updateShowInLeaderboard(id: string, show: boolean): Promise<void>;
  getLeaderboard(): Promise<{ username: string; totalTokens: number; totalTraces: number }[]>;

  // Two-factor auth
  setTwoFactor(id: string, settings: TwoFactorSettings): Promise<void>;
  setBackupCodes(id: string, hashes: string[]): Promise<void>;
  savePendingOtp(userId: string, codeHash: string, expiresAt: number): Promise<void>;
  getPendingOtp(userId: string): Promise<PendingOtp | null>;
  bumpOtpAttempts(userId: string): Promise<number>;
  clearPendingOtp(userId: string): Promise<void>;

  // Onboarding
  setOnboardedAt(id: string, at: number | null): Promise<void>;

  // Consent. Writing the audit row and updating current state is one operation
  // on purpose: a state change without its evidence row is a compliance hole.
  recordConsent(
    userId: string,
    kind: ConsentKind,
    granted: boolean,
    version: string,
    source: ConsentSource
  ): Promise<void>;

  // Erasure (GDPR Art. 17). Removes the account row and everything hanging off
  // it — credentials, pending OTPs, consent events. Interaction data lives in
  // the Go backend and is deleted separately by the caller.
  deleteUser(id: string): Promise<void>;
}
