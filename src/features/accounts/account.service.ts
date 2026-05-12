/**
 * Account Service (Use Cases / Logic)
 * 
 * Orchestrates the interactions between Auth, API, and DB services.
 * Implements the core workflows of the extension.
 */

import * as vscode from 'vscode';
import { AuthService } from '../../infrastructure/auth/auth.service';
import { BalanceService } from '../../infrastructure/api/balance.service';
import { IAccountRepository } from '../../core/domain/repositories/account.repository';
import { StateDbService } from '../../infrastructure/storage/state-db.service';
import { Logger } from '../../core/utils/logger';
import { I18nService } from '../../i18n/i18n.service';
import { AccountStatus } from '../../core/domain/models/account.model';
import { ExtensionConfig } from '../../core/config/extension.config';
import { generateDeviceProfile } from '../../core/domain/models/device-profile.model';

export class AccountService {
  private _onAccountsChanged = new vscode.EventEmitter<void>();
  public readonly onAccountsChanged = this._onAccountsChanged.event;

  /** Manually fire the accounts changed event (e.g. after import) */
  public emitAccountsChanged(): void {
    this._onAccountsChanged.fire();
  }

  /** Timestamp of the last successful refresh start (ms) */
  private _lastRefreshTime: number = 0;
  /** Minimum interval between refreshes in milliseconds (30 seconds) */
  private static readonly REFRESH_COOLDOWN_MS = 30_000;
  /** Whether a refresh is currently in progress */
  private _isRefreshing: boolean = false;

  constructor(
    private authService: AuthService,
    private balanceService: BalanceService,
    private accountRepo: IAccountRepository,
    private stateDbService: StateDbService
  ) {}

  /**
   * Workflow: Add a new Google account
   * Authenticates, fetches initial balance (fails gracefully), and saves locally.
   */
  async addAccountWorkflow(): Promise<void> {
    const i18n = I18nService.getInstance();
    
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: i18n.t('auth.signingIn'),
        cancellable: false
      }, async (progress) => {
        
        // 1. Authenticate via Browser
        const { tokens, profile } = await this.authService.login();

        progress.report({ message: i18n.t('common.loading') });

        // 2. Fetch Initial Balance (Decision 1: Fails gracefully)
        const balanceInfo = await this.balanceService.getBalanceInfo(tokens.accessToken);
        
        // 3. Save core account data and secure tokens
        const expiresAt = Math.floor(Date.now() / 1000) + tokens.expiresIn;
        await this.accountRepo.saveAccount({
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.picture,
          projectId: balanceInfo.projectId,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: expiresAt
        });

        // Determine status based on config thresholds
        const config = ExtensionConfig.getInstance();
        let finalStatus = balanceInfo.hasError ? AccountStatus.ERROR : AccountStatus.ACTIVE;
        
        let totalCredits = 0;
        if (!balanceInfo.hasError) {
          const values = Object.values(balanceInfo.balances);
          totalCredits = values.reduce((sum, val) => sum + (typeof val === 'number' ? val : (val?.value || 0)), 0);

          if (values.length > 0 && totalCredits <= 0) finalStatus = AccountStatus.DEPLETED;
          else if (totalCredits <= config.getLowCreditThreshold()) finalStatus = AccountStatus.LOW_BALANCE;
        }

        // 4. Update dynamic properties (balances, plan)
        await this.accountRepo.updateAccount(profile.email, {
          balances: balanceInfo.balances,
          plan: balanceInfo.plan,
          status: finalStatus,
          lastRefreshedAt: new Date().toISOString()
        });

        // 5. Generate unique Device Profile for this account
        progress.report({ message: i18n.t('service.generatingDeviceProfile') });
        const existingProfile = await this.accountRepo.getDeviceProfile(profile.email);
        if (!existingProfile) {
          const deviceProfile = generateDeviceProfile();
          await this.accountRepo.storeDeviceProfile(profile.email, deviceProfile);
          Logger.getInstance().info(`Generated new device profile for ${profile.email}`);
        }

        // 6. Notify User
        if (balanceInfo.hasError) {
          vscode.window.showWarningMessage(i18n.t('service.accountAddedErrorBalance', { email: profile.email }));
        } else {
          const formattedBalances = Object.entries(balanceInfo.balances).map(([k, v]) => `${k}: ${v}`).join(' | ');
          vscode.window.showInformationMessage(i18n.t('service.accountAddedSuccess', { email: profile.email, balances: formattedBalances }));
        }
        
        this._onAccountsChanged.fire();
      });
    } catch (error: any) {
      Logger.getInstance().error('Add account workflow failed', error);
      vscode.window.showErrorMessage(i18n.t('service.accountAddError', { error: error.message }));
    }
  }

  /**
   * Workflow: Switch active account
   * Validates/refreshes token, injects into SQLite, and marks active.
   */
  async switchAccountWorkflow(email: string): Promise<void> {
    const account = await this.accountRepo.getAccount(email);
    if (!account) return;

    let tokens = await this.accountRepo.getTokens(email);
    if (!tokens) {
      const i18n = I18nService.getInstance();
      vscode.window.showErrorMessage(i18n.t('service.missingLoginData', { email }));
      return;
    }

    // Decision 2: Pre-emptive Token Refresh (Add 5-minute buffer)
    const now = Math.floor(Date.now() / 1000);
    if (tokens.expiresAt < (now + 300)) {
      Logger.getInstance().info(`Token for ${email} is expired or expiring soon. Refreshing before injection...`);
      try {
        const newTokens = await this.authService.refreshAccessToken(tokens.refreshToken);
        tokens = {
          accessToken: newTokens.accessToken,
          refreshToken: newTokens.refreshToken, // Keeps original if response omits it
          expiresAt: now + newTokens.expiresIn
        };
        await this.accountRepo.storeTokens(email, tokens);
        Logger.getInstance().info(`Token refreshed successfully for ${email}`);
      } catch (e: any) {
        Logger.getInstance().error(`Failed to refresh token for ${email}`, e);
        const i18n = I18nService.getInstance();
        vscode.window.showErrorMessage(i18n.t('service.sessionExpiredFailed', { email }));
        await this.accountRepo.updateAccount(email, { status: AccountStatus.TOKEN_EXPIRED });
        return;
      }
    }

    // Ensure device profile exists (generate if missing — for accounts added before this feature)
    let deviceProfile = await this.accountRepo.getDeviceProfile(email);
    if (!deviceProfile) {
      Logger.getInstance().info(`No device profile found for ${email}. Generating one now...`);
      deviceProfile = generateDeviceProfile();
      await this.accountRepo.storeDeviceProfile(email, deviceProfile);
    } else if (!deviceProfile.firstSessionDate) {
      // Backward compatibility: older profiles lack firstSessionDate.
      // Generate only the missing field; keep all other IDs stable.
      const { generatePlausibleFirstSessionDate } = await import('../../core/domain/models/device-profile.model');
      deviceProfile.firstSessionDate = generatePlausibleFirstSessionDate();
      await this.accountRepo.storeDeviceProfile(email, deviceProfile);
      Logger.getInstance().info(`Migrated device profile for ${email}: added firstSessionDate.`);
    }

    // Inject into Database (tokens + device profile + telemetry)
    const result = await this.stateDbService.injectAccountState(account, tokens, deviceProfile);
    
    if (result === 'success') {
      // We no longer save the active account in the local DB.
      // It will be dynamically detected from Antigravity's state.vscdb on next render.
      this._onAccountsChanged.fire();
      // NOTE: Window reload is handled by StateDbService if user consents
    } else if (result === 'error') {
      const i18n = I18nService.getInstance();
      vscode.window.showErrorMessage(i18n.t('service.switchFailed', { email }));
    }
  }

  /**
   * Get the currently active account email directly from Antigravity's state database.
   * Does NOT rely on the tool's local database.
   */
  async getActiveAntigravityEmail(): Promise<string | null | undefined> {
    try {
      return await this.stateDbService.readCurrentEmailFromDb();
    } catch (error) {
      Logger.getInstance().error('Failed to read active account from Antigravity', error);
      return undefined;
    }
  }

  /**
   * Workflow: Refresh all balances
   * Loops through all stored accounts and updates their credits/status.
   * 
   * Supports per-account progress callbacks and cancellation.
   * @param notify Whether to show toast notification on completion
   * @param options.onAccountStart Called when an individual account starts refreshing
   * @param options.onAccountDone  Called when an individual account finishes (success or skip)
   * @param options.onComplete     Called when all accounts are done
   * @param options.signal         AbortSignal to cancel the refresh mid-loop
   * @param options.orderedEmails  If provided, accounts are refreshed in this order (matching UI display order)
   */
  async refreshBalancesWorkflow(
    notify: boolean = true,
    options?: {
      onAccountStart?: (email: string) => void;
      onAccountDone?: (email: string, updatedBalances?: Record<string, any>, updatedStatus?: AccountStatus) => void;
      onComplete?: () => void;
      signal?: AbortSignal;
      orderedEmails?: string[];
    }
  ): Promise<void> {
    // ── Guard: Prevent concurrent or rapid-fire refreshes ──
    if (this._isRefreshing) {
      Logger.getInstance().info('Refresh already in progress, ignoring duplicate request.');
      if (notify) {
        const i18n = I18nService.getInstance();
        vscode.window.showInformationMessage(i18n.t('service.refreshInProgress'));
      }
      return;
    }

    const now = Date.now();
    const elapsed = now - this._lastRefreshTime;
    if (elapsed < AccountService.REFRESH_COOLDOWN_MS) {
      const remainingSec = Math.ceil((AccountService.REFRESH_COOLDOWN_MS - elapsed) / 1000);
      Logger.getInstance().info(`Refresh cooldown active. ${remainingSec}s remaining.`);
      if (notify) {
        const i18n = I18nService.getInstance();
        vscode.window.showInformationMessage(i18n.t('service.refreshCooldown', { seconds: remainingSec }));
      }
      return;
    }

    this._isRefreshing = true;
    this._lastRefreshTime = now;

    try {
    let accounts = await this.accountRepo.getAllAccounts();
    if (accounts.length === 0) { this._isRefreshing = false; return; }

    // Reorder accounts to match UI display order if provided
    if (options?.orderedEmails && options.orderedEmails.length > 0) {
      const emailOrder = options.orderedEmails.map(e => e.toLowerCase());
      accounts = [...accounts].sort((a, b) => {
        const aIdx = emailOrder.indexOf(a.email.toLowerCase());
        const bIdx = emailOrder.indexOf(b.email.toLowerCase());
        const aPos = aIdx === -1 ? emailOrder.length : aIdx;
        const bPos = bIdx === -1 ? emailOrder.length : bIdx;
        return aPos - bPos;
      });
    }

    let successCount = 0;
    const config = ExtensionConfig.getInstance();

    for (const account of accounts) {
      // ── Check for cancellation ──
      if (options?.signal?.aborted) {
        Logger.getInstance().info('Refresh cancelled by user.');
        break;
      }

      // Notify UI: this account is starting
      options?.onAccountStart?.(account.email);

      let tokens = await this.accountRepo.getTokens(account.email);
      if (!tokens) {
        options?.onAccountDone?.(account.email);
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      
      // Auto-refresh token if needed before API call
      if (tokens.expiresAt < (now + 300)) {
         try {
           const newTokens = await this.authService.refreshAccessToken(tokens.refreshToken);
           tokens.accessToken = newTokens.accessToken;
           tokens.expiresAt = now + newTokens.expiresIn;
           await this.accountRepo.storeTokens(account.email, tokens);
         } catch(e) {
           Logger.getInstance().warn(`Skipping balance fetch for ${account.email} due to expired token.`);
           await this.accountRepo.updateAccount(account.email, { status: AccountStatus.TOKEN_EXPIRED });
           options?.onAccountDone?.(account.email, undefined, AccountStatus.TOKEN_EXPIRED);
           continue; 
         }
      }

      // Check cancellation again before API call
      if (options?.signal?.aborted) {
        Logger.getInstance().info('Refresh cancelled by user before API call.');
        break;
      }

      // Fetch Balance
      const balanceInfo = await this.balanceService.getBalanceInfo(tokens.accessToken);
      
      let status = balanceInfo.hasError ? AccountStatus.ERROR : AccountStatus.ACTIVE;
      
      if (!balanceInfo.hasError) {
        const values = Object.values(balanceInfo.balances);
        const totalCredits = values.reduce((sum: number, val: any) => sum + (typeof val === 'number' ? val : (val?.value || 0)), 0);

        if (values.length > 0 && totalCredits <= 0) {
          status = AccountStatus.DEPLETED;
        } else if (totalCredits <= config.getLowCreditThreshold()) {
          status = AccountStatus.LOW_BALANCE;
        }
        successCount++;
      }

      await this.accountRepo.updateAccount(account.email, {
        balances: balanceInfo.balances,
        plan: balanceInfo.plan,
        status: status,
        lastRefreshedAt: new Date().toISOString()
      });

      // Notify UI: this account is done with updated data
      options?.onAccountDone?.(account.email, balanceInfo.balances, status);
    }

    const wasCancelled = !!options?.signal?.aborted;

    if (wasCancelled) {
      // Don't show "all refreshed" — show cancellation notice instead
      if (notify) {
        const i18n = I18nService.getInstance();
        vscode.window.showInformationMessage(i18n.t('accounts.refreshCancelled'));
      }
    } else if (notify && successCount > 0) {
      const i18n = I18nService.getInstance();
      vscode.window.showInformationMessage(i18n.t('notifications.refreshComplete'));
    }
    
    // Update global refresh timestamp
    await this.accountRepo.setBalancesLastRefreshed(Date.now());
    
    // Notify UI: all done
    options?.onComplete?.();
    
    this._onAccountsChanged.fire();
    } finally {
      this._isRefreshing = false;
    }
  }

  /**
   * Refreshes the balance for a single account.
   * Used when auto-refresh is disabled — only the active account gets updated.
   * Follows the same per-account logic as refreshBalancesWorkflow.
   */
  async refreshSingleAccountBalance(
    email: string,
    callbacks?: {
      onStart?: (email: string) => void;
      onDone?: (email: string, balances?: Record<string, any>, status?: AccountStatus) => void;
    }
  ): Promise<void> {
    const account = await this.accountRepo.getAccount(email);
    if (!account) return;

    callbacks?.onStart?.(email);

    let tokens = await this.accountRepo.getTokens(email);
    if (!tokens) {
      callbacks?.onDone?.(email);
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    // Auto-refresh token if needed before API call
    if (tokens.expiresAt < (now + 300)) {
      try {
        const newTokens = await this.authService.refreshAccessToken(tokens.refreshToken);
        tokens.accessToken = newTokens.accessToken;
        tokens.expiresAt = now + newTokens.expiresIn;
        await this.accountRepo.storeTokens(email, tokens);
      } catch (e) {
        Logger.getInstance().warn(`Skipping balance fetch for ${email}: expired token.`);
        await this.accountRepo.updateAccount(email, { status: AccountStatus.TOKEN_EXPIRED });
        callbacks?.onDone?.(email, undefined, AccountStatus.TOKEN_EXPIRED);
        return;
      }
    }

    const config = ExtensionConfig.getInstance();
    const balanceInfo = await this.balanceService.getBalanceInfo(tokens.accessToken);

    let status = balanceInfo.hasError ? AccountStatus.ERROR : AccountStatus.ACTIVE;

    if (!balanceInfo.hasError) {
      const values = Object.values(balanceInfo.balances);
      const totalCredits = values.reduce((sum: number, val: any) => sum + (typeof val === 'number' ? val : (val?.value || 0)), 0);

      if (values.length > 0 && totalCredits <= 0) {
        status = AccountStatus.DEPLETED;
      } else if (totalCredits <= config.getLowCreditThreshold()) {
        status = AccountStatus.LOW_BALANCE;
      }
    }

    await this.accountRepo.updateAccount(email, {
      balances: balanceInfo.balances,
      plan: balanceInfo.plan,
      status: status,
      lastRefreshedAt: new Date().toISOString()
    });

    callbacks?.onDone?.(email, balanceInfo.balances, status);

    // Update global refresh timestamp
    await this.accountRepo.setBalancesLastRefreshed(Date.now());
  }

  /**
   * Workflow: Re-authenticate an account with an expired token
   * Runs the OAuth flow again for the SAME email, verifies identity,
   * and updates stored tokens without losing any account data (alias, device profile, etc.).
   */
  async reAuthenticateWorkflow(email: string): Promise<void> {
    const i18n = I18nService.getInstance();

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: i18n.t('auth.reAuthenticating', { email }),
        cancellable: false
      }, async (progress) => {

        // 1. Run the OAuth login flow (opens browser)
        const { tokens, profile } = await this.authService.login();

        // 2. SECURITY CHECK: Verify the returned email matches the original account
        if (profile.email.toLowerCase() !== email.toLowerCase()) {
          throw new Error(i18n.t('service.reAuthEmailMismatch', {
            expected: email,
            actual: profile.email
          }));
        }

        progress.report({ message: i18n.t('common.loading') });

        // 3. Update stored tokens (preserves all other account data)
        const expiresAt = Math.floor(Date.now() / 1000) + tokens.expiresIn;
        await this.accountRepo.storeTokens(email, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: expiresAt
        });

        // 4. Update avatar if changed
        if (profile.picture) {
          await this.accountRepo.updateAccount(email, {
            avatarUrl: profile.picture
          });
        }

        // 5. Reset status back to ACTIVE
        await this.accountRepo.updateAccount(email, {
          status: AccountStatus.ACTIVE
        });

        Logger.getInstance().info(`Successfully re-authenticated ${email}`);
        vscode.window.showInformationMessage(i18n.t('service.reAuthSuccess', { email }));

        this._onAccountsChanged.fire();

        // 6. Silently refresh balances in the background
        this.refreshBalancesWorkflow(false).catch(() => {});
      });
    } catch (error: any) {
      Logger.getInstance().error(`Re-authentication failed for ${email}`, error);
      vscode.window.showErrorMessage(i18n.t('service.reAuthFailed', { email, error: error.message }));
    }
  }

  /**
   * Workflow: Remove account
   * Prompts for confirmation and wipes data.
   */
  async removeAccountWorkflow(email: string): Promise<void> {
    const i18n = I18nService.getInstance();
    const actionYes = i18n.t('common.delete');
    
    const choice = await vscode.window.showWarningMessage(
      i18n.t('accounts.confirmDelete') + ` (${email})`,
      { modal: true, detail: i18n.t('accounts.deleteWarning') },
      actionYes,
      i18n.t('common.cancel')
    );

    if (choice === actionYes) {
      await this.accountRepo.removeAccount(email);
      vscode.window.showInformationMessage(i18n.t('service.accountRemoved', { email }));
      
      // We no longer need to check or clear the active account in local DB
      // because it is dynamically read from Antigravity.
      
      this._onAccountsChanged.fire();
    }
  }
}
