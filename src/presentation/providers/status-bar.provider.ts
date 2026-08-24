/** Displays the active account and its unified quota groups in the status bar. */
import * as vscode from 'vscode';
import { AccountStatus } from '../../core/domain/models/account.model';
import { IAccountRepository } from '../../core/domain/repositories/account.repository';
import { formatQuotaSummaryCompact, formatQuotaSummaryDetailed } from '../../core/utils/quota-display.utils';
import { deriveQuotaSummaryFromBalances } from '../../core/utils/quota-summary.utils';
import { AccountService } from '../../features/accounts/account.service';
import { I18nService } from '../../i18n/i18n.service';

export class StatusBarProvider implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(
    private readonly accountRepo: IAccountRepository,
    private readonly accountService: AccountService
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'antigravity-hub.switchAccount';
    void this.update();
  }

  async update(): Promise<void> {
    const activeEmail = await this.accountService.getActiveAntigravityEmail();
    const i18n = I18nService.getInstance();

    if (activeEmail === undefined) {
      return;
    }
    if (!activeEmail) {
      this.statusBarItem.text = `$(account) ${i18n.t('statusBar.noAccount')}`;
      this.statusBarItem.tooltip = i18n.t('statusBar.tooltip');
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
      return;
    }

    const activeAccount = await this.accountRepo.getAccount(activeEmail)
      || (await this.accountRepo.getAllAccounts()).find(
        account => account.email.toLowerCase() === activeEmail.toLowerCase()
      );
    if (!activeAccount) {
      this.statusBarItem.hide();
      return;
    }

    const displayName = activeAccount.alias || activeAccount.email.split('@')[0];
    const quotaSummary = activeAccount.quotaSummary?.length
      ? activeAccount.quotaSummary
      : deriveQuotaSummaryFromBalances(activeAccount.balances);
    const translate = (key: string, params?: Record<string, string | number>) => i18n.t(key, params);

    this.statusBarItem.text = `$(hubot) ${displayName} | ${formatQuotaSummaryCompact(quotaSummary, translate)}`;
    this.statusBarItem.tooltip = [
      activeAccount.email,
      '',
      formatQuotaSummaryDetailed(quotaSummary, translate),
      '',
      i18n.t('statusBar.tooltip'),
    ].join('\n');

    if (
      activeAccount.status === AccountStatus.DEPLETED
      || activeAccount.status === AccountStatus.ERROR
      || activeAccount.status === AccountStatus.TOKEN_EXPIRED
    ) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (activeAccount.status === AccountStatus.LOW_BALANCE) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    this.statusBarItem.show();
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
