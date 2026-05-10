/**
 * Account Entity — Core domain model
 *
 * Represents a user's Antigravity/Google account.
 * This is a pure data model with no framework dependencies.
 */

/** Account subscription plan types */
export enum AccountPlan {
  FREE = 'free',
  PREMIUM = 'premium',
  ULTRA = 'ultra',
  UNKNOWN = 'unknown',
}

/** Account health/connection status */
export enum AccountStatus {
  ACTIVE = 'active',
  LOW_BALANCE = 'low_balance',
  DEPLETED = 'depleted',
  TOKEN_EXPIRED = 'token_expired',
  ERROR = 'error',
}

/** Core account data structure */
export interface Account {
  /** Google account email (unique identifier) */
  email: string;

  /** Display name from Google profile */
  name: string;

  /** User-defined alias (optional, e.g., "Work Account") */
  alias?: string;

  /** Profile picture URL */
  avatarUrl?: string;

  /** GCP project ID (for Enterprise accounts) */
  projectId?: string;

  /** Subscription plan */
  plan: AccountPlan;

  /** Current account status */
  status: AccountStatus;

  /** Map of model names to their remaining credits/quotas */
  balances: Record<string, any>;

  /** Maximum credits for the plan (if known) */
  maxCredits?: number;

  /** Timestamp when the account was added (ISO string) */
  addedAt: string;

  /** Timestamp of last balance refresh (ISO string) */
  lastRefreshedAt?: string;

  /** Whether this account is currently active in Antigravity */
  isActive: boolean;

  /** Whether a device profile has been generated for this account */
  hasDeviceProfile: boolean;
}

/** Minimal data needed to create a new account after OAuth */
export interface AccountCreationData {
  email: string;
  name: string;
  avatarUrl?: string;
  projectId?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in seconds
  /** GCP Terms of Service acceptance flag (auto-corrected based on email domain) */
  isGcpTos?: boolean;
}

/** Token pair stored in SecretStorage */
export interface AccountTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in seconds
}

/** Summary for quick-pick / status bar display */
export interface AccountSummary {
  email: string;
  displayName: string; // alias || name || email
  balances?: Record<string, any>;
  status: AccountStatus;
  isActive: boolean;
}
