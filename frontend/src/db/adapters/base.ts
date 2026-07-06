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
}
