/**
 * Account Repository Interface — Domain contract
 *
 * Defines the contract for account persistence.
 * Infrastructure layer (SecretStorage, globalState) implements this.
 * This follows the Dependency Inversion principle (SOLID).
 */

import { Account, AccountCreationData, AccountTokens, AccountSummary } from '../models/account.model';
import { DeviceProfile } from '../models/device-profile.model';

export interface IAccountRepository {
  /** Get all stored accounts (without tokens) */
  getAllAccounts(): Promise<Account[]>;

  /** Get a single account by email */
  getAccount(email: string): Promise<Account | null>;

  /** Save a new account (after OAuth) */
  saveAccount(data: AccountCreationData): Promise<Account>;

  /** Remove an account and its tokens */
  removeAccount(email: string): Promise<void>;

  /** Update account metadata (alias, credits, status, etc.) */
  updateAccount(email: string, updates: Partial<Account>): Promise<void>;

  /** Get the currently active account email */
  getActiveAccountEmail(): Promise<string | null>;

  /** Set the active account */
  setActiveAccount(email: string): Promise<void>;

  /** Store tokens securely */
  storeTokens(email: string, tokens: AccountTokens): Promise<void>;

  /** Retrieve tokens */
  getTokens(email: string): Promise<AccountTokens | null>;

  /** Get summaries for quick-pick display */
  getAccountSummaries(): Promise<AccountSummary[]>;

  /** Store a device profile securely for an account */
  storeDeviceProfile(email: string, profile: DeviceProfile): Promise<void>;

  /** Retrieve the device profile for an account */
  getDeviceProfile(email: string): Promise<DeviceProfile | null>;

  /** Get the user's preferred model key (null = never set, "" = explicitly none) */
  getPreferredModel(): Promise<string | null>;

  /** Set the user's preferred model key */
  setPreferredModel(modelKey: string): Promise<void>;

  /** Get the timestamp (ms) of when balances were last globally refreshed */
  getBalancesLastRefreshed(): Promise<number>;

  /** Set the timestamp (ms) of when balances were last globally refreshed */
  setBalancesLastRefreshed(timestampMs: number): Promise<void>;
}
