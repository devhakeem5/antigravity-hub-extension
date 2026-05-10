/**
 * Account Repository Implementation
 *
 * Concrete implementation of IAccountRepository.
 * Uses VS Code `globalState` for non-sensitive data,
 * and `SecretStorage` for OAuth tokens.
 */

import * as vscode from 'vscode';
import { IAccountRepository } from '../../core/domain/repositories/account.repository';
import { Account, AccountCreationData, AccountTokens, AccountSummary } from '../../core/domain/models/account.model';
import { DeviceProfile } from '../../core/domain/models/device-profile.model';
import { STORAGE_KEYS, SECRET_KEYS } from '../../core/constants/app.constants';
import { Logger } from '../../core/utils/logger';

export class AccountRepositoryImpl implements IAccountRepository {
  constructor(private context: vscode.ExtensionContext) {}

  async getAllAccounts(): Promise<Account[]> {
    const accounts = this.context.globalState.get<Account[]>(STORAGE_KEYS.ACCOUNTS_LIST, []);
    return accounts;
  }

  async getAccount(email: string): Promise<Account | null> {
    const accounts = await this.getAllAccounts();
    return accounts.find(a => a.email === email) || null;
  }

  async saveAccount(data: AccountCreationData): Promise<Account> {
    const accounts = await this.getAllAccounts();
    
    // Check if exists
    const existingIndex = accounts.findIndex(a => a.email === data.email);
    
    // Map Creation Data to Domain Model
    const newAccount: Account = {
      email: data.email,
      name: data.name,
      avatarUrl: data.avatarUrl,
      projectId: data.projectId,
      plan: 'unknown' as any, // Will be updated later by API
      status: 'active' as any,
      balances: {},
      addedAt: new Date().toISOString(),
      isActive: false,
      hasDeviceProfile: false,
    };

    if (existingIndex >= 0) {
      // Keep existing data (like alias), update core info
      accounts[existingIndex] = { ...accounts[existingIndex], ...newAccount, addedAt: accounts[existingIndex].addedAt };
    } else {
      accounts.push(newAccount);
    }

    await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, accounts);

    // Save tokens securely
    await this.storeTokens(data.email, {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: data.expiresAt
    });

    Logger.getInstance().info(`Account saved/updated: ${data.email}`);
    return newAccount;
  }

  async removeAccount(email: string): Promise<void> {
    const accounts = await this.getAllAccounts();
    const filtered = accounts.filter(a => a.email !== email);
    await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, filtered);

    // Remove tokens securely
    await this.context.secrets.delete(SECRET_KEYS.REFRESH_TOKEN(email));
    await this.context.secrets.delete(SECRET_KEYS.ACCESS_TOKEN(email));
    await this.context.secrets.delete(SECRET_KEYS.METADATA(email));
    
    Logger.getInstance().info(`Account removed: ${email}`);
  }

  async updateAccount(email: string, updates: Partial<Account>): Promise<void> {
    const accounts = await this.getAllAccounts();
    const index = accounts.findIndex(a => a.email === email);
    
    if (index >= 0) {
      accounts[index] = { ...accounts[index], ...updates };
      await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, accounts);
    }
  }

  async getActiveAccountEmail(): Promise<string | null> {
    return this.context.globalState.get<string | null>(STORAGE_KEYS.ACTIVE_ACCOUNT, null);
  }

  async setActiveAccount(email: string): Promise<void> {
    const accounts = await this.getAllAccounts();
    
    // Deactivate all, activate the target
    const updatedAccounts = accounts.map(a => ({
      ...a,
      isActive: a.email === email
    }));

    await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, updatedAccounts);
    await this.context.globalState.update(STORAGE_KEYS.ACTIVE_ACCOUNT, email);
    
    Logger.getInstance().info(`Active account set to: ${email}`);
  }

  async storeTokens(email: string, tokens: AccountTokens): Promise<void> {
    await this.context.secrets.store(SECRET_KEYS.REFRESH_TOKEN(email), tokens.refreshToken);
    await this.context.secrets.store(SECRET_KEYS.ACCESS_TOKEN(email), tokens.accessToken);
    // Expiration metadata
    await this.context.secrets.store(SECRET_KEYS.METADATA(email), JSON.stringify({ expiresAt: tokens.expiresAt }));
  }

  async getTokens(email: string): Promise<AccountTokens | null> {
    try {
      const refreshToken = await this.context.secrets.get(SECRET_KEYS.REFRESH_TOKEN(email));
      const accessToken = await this.context.secrets.get(SECRET_KEYS.ACCESS_TOKEN(email));
      const metaStr = await this.context.secrets.get(SECRET_KEYS.METADATA(email));
      
      if (!refreshToken || !accessToken) return null;
      
      const meta = metaStr ? JSON.parse(metaStr) : { expiresAt: 0 };
      
      return {
        refreshToken,
        accessToken,
        expiresAt: meta.expiresAt
      };
    } catch (e) {
      Logger.getInstance().error(`Failed to retrieve tokens for ${email}`, e);
      return null;
    }
  }

  async getAccountSummaries(): Promise<AccountSummary[]> {
    const accounts = await this.getAllAccounts();
    return accounts.map(a => ({
      email: a.email,
      displayName: a.alias || a.name || a.email,
      avatarUrl: a.avatarUrl,
      balances: a.balances,
      status: a.status,
      isActive: a.isActive
    }));
  }

  // ── Device Profile Storage (SecretStorage) ──────────────────────────────────

  private deviceProfileKey(email: string): string {
    return `antigravity.account.${email}.deviceProfile`;
  }

  async storeDeviceProfile(email: string, profile: DeviceProfile): Promise<void> {
    await this.context.secrets.store(
      this.deviceProfileKey(email),
      JSON.stringify(profile)
    );
    // Mark account as having a device profile
    await this.updateAccount(email, { hasDeviceProfile: true } as Partial<Account>);
    Logger.getInstance().info(`Device profile stored securely for: ${email}`);
  }

  async getDeviceProfile(email: string): Promise<DeviceProfile | null> {
    try {
      const raw = await this.context.secrets.get(this.deviceProfileKey(email));
      if (!raw) return null;
      return JSON.parse(raw) as DeviceProfile;
    } catch (e) {
      Logger.getInstance().error(`Failed to retrieve device profile for ${email}`, e);
      return null;
    }
  }

  // ── Preferred Model Setting ─────────────────────────────────────────────────

  async getPreferredModel(): Promise<string | null> {
    return this.context.globalState.get<string | null>(STORAGE_KEYS.PREFERRED_MODEL, null);
  }

  async setPreferredModel(modelKey: string): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.PREFERRED_MODEL, modelKey);
    Logger.getInstance().info(`Preferred model set to: ${modelKey || '(none)'}`);
  }

  // ── Global Balance Refresh Timestamp ────────────────────────────────────────

  async getBalancesLastRefreshed(): Promise<number> {
    return this.context.globalState.get<number>(STORAGE_KEYS.BALANCES_LAST_REFRESHED, 0);
  }

  async setBalancesLastRefreshed(timestampMs: number): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.BALANCES_LAST_REFRESHED, timestampMs);
  }
}
