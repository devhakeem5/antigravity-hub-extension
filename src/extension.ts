/**
 * Antigravity Hub — VS Code Extension Entry Point
 *
 * This is the main activation/deactivation entry for the extension.
 * It follows the Composition Root pattern: all dependencies are wired here
 * and injected into the appropriate layers.
 */

import * as vscode from 'vscode';
import { Logger } from './core/utils/logger';
import { I18nService } from './i18n/i18n.service';
import { ExtensionConfig } from './core/config/extension.config';

import { AuthService } from './infrastructure/auth/auth.service';
import { BalanceService } from './infrastructure/api/balance.service';
import { AccountRepositoryImpl } from './infrastructure/storage/account.repository.impl';
import { StateDbService } from './infrastructure/storage/state-db.service';
import { AccountService } from './features/accounts/account.service';
import { StatusBarProvider } from './presentation/providers/status-bar.provider';
import { AccountsWebviewProvider } from './presentation/providers/accounts-webview.provider';
// TODO : complete Investigation Account Switching conversation

/**
 * Called when the extension is activated.
 * Responsible for:
 * - Initializing core services (Logger, I18n, Config)
 * - Registering commands
 * - Setting up the sidebar webview
 * - Initializing the status bar
 */
export function activate(context: vscode.ExtensionContext): void {
  const logger = Logger.getInstance();
  logger.info('Antigravity Hub is activating...');

  // ── Initialize Configuration ──
  const config = ExtensionConfig.getInstance();
  config.initialize(context);

  // ── Initialize i18n ──
  const i18n = I18nService.getInstance();
  
  const updateLanguage = () => {
    let language = config.getLanguage();
    if (language === 'auto') {
      const editorLang = vscode.env.language.split('-')[0].toLowerCase();
      language = editorLang === 'ar' ? 'ar' : 'en';
    }
    i18n.setLocale(language);
    logger.info(`Language set to: ${language} (configured: ${config.getLanguage()})`);
  };
  
  updateLanguage();

  // ── Register Commands ──
  const commands = registerCommands(context, i18n);
  context.subscriptions.push(...commands);

  // ── Listen for configuration changes ──
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityHub.language')) {
        updateLanguage();
      }
    })
  );

  logger.info('Antigravity Hub activated successfully.');
}

/**
 * Called when the extension is deactivated.
 * Clean up resources here.
 */
export function deactivate(): void {
  const logger = Logger.getInstance();
  logger.info('Antigravity Hub deactivated.');
}

/**
 * Register all extension commands.
 * Each command delegates to the appropriate use case / controller.
 */
function registerCommands(
  context: vscode.ExtensionContext,
  i18n: I18nService
): vscode.Disposable[] {
  const authService = new AuthService();
  const balanceService = new BalanceService();
  const accountRepo = new AccountRepositoryImpl(context);
  const stateDbService = new StateDbService(context);
  const accountService = new AccountService(authService, balanceService, accountRepo, stateDbService);

  const disposables: vscode.Disposable[] = [];

  // Initialize UI Providers
  const statusBarProvider = new StatusBarProvider(accountRepo, accountService);
  disposables.push(statusBarProvider);

  const accountsProvider = new AccountsWebviewProvider(context.extensionUri, accountRepo, accountService);
  disposables.push(
    vscode.window.registerWebviewViewProvider(AccountsWebviewProvider.viewType, accountsProvider)
  );

  // Listen for account state changes to update UI
  disposables.push(
    accountService.onAccountsChanged(() => {
      statusBarProvider.update();
    })
  );

  // No longer syncing on startup, webview detects it dynamically on render.

  disposables.push(
    vscode.commands.registerCommand('antigravity-hub.openPanel', () => {
      // Focus the webview panel in the sidebar
      vscode.commands.executeCommand('antigravity-hub.accountsView.focus');
    })
  );



  disposables.push(
    vscode.commands.registerCommand('antigravity-hub.addAccount', async () => {
      await accountService.addAccountWorkflow();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-hub.switchAccount', async () => {
      // Temporary quick pick until UI is built
      const accounts = await accountRepo.getAccountSummaries();
      if (accounts.length === 0) {
        vscode.window.showWarningMessage(i18n.t('extension.noAccountsToSwitch'));
        return;
      }

      // Dynamically detect the active account from Antigravity's state.vscdb
      const activeEmail = await accountService.getActiveAntigravityEmail();
      const activeEmailLower = activeEmail?.toLowerCase() ?? null;

      const items = accounts.map(a => {
        const isActive = activeEmailLower !== null && a.email.toLowerCase() === activeEmailLower;
        let creditsStr = '?';
        if (a.balances && Object.keys(a.balances).length > 0) {
          creditsStr = Object.values(a.balances).join('/');
        }
        return {
          label: `${isActive ? '✅ ' : ''}${a.displayName}`,
          description: `${creditsStr} Credits`,
          email: a.email
        };
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: i18n.t('extension.selectAccountToSwitch')
      });

      if (picked) {
        await accountService.switchAccountWorkflow(picked.email);
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-hub.refreshBalances', async () => {
      await accountService.refreshBalancesWorkflow(true);
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-hub.setLanguage', async () => {
      const languages = [
        { label: i18n.t('webview.languageAuto'), description: 'auto' },
        ...i18n.getAvailableLocales().map((locale) => ({
          label: locale.name,
          description: locale.code,
        }))
      ];

      const picked = await vscode.window.showQuickPick(languages, {
        placeHolder: i18n.t('commands.setLanguage.placeholder'),
      });

      if (picked) {
        const extConfig = vscode.workspace.getConfiguration('antigravityHub');
        await extConfig.update('language', picked.description, vscode.ConfigurationTarget.Global);
        vscode.commands.executeCommand('antigravity-hub.openPanel'); // trigger webview focus to reflect changes if possible
      }
    })
  );

  return disposables;
}
