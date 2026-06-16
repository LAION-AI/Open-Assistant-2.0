export interface UserRecord {
  id: string;
  username: string;
  email?: string | null;
  credits: number;
  byoeUrl?: string | null;
  byoeKey?: string | null;
  byoeModel?: string | null;
  apiKey?: string | null;
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
  getUserByApiKey(apiKey: string): Promise<UserRecord | null>;
  createUser(username: string): Promise<UserRecord>;
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
}
