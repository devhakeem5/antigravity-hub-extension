/**
 * Extension Configuration — Centralized configuration access
 *
 * Wraps VS Code's configuration API with typed accessors
 * for all Antigravity Hub settings.
 */

import * as vscode from 'vscode';

const CONFIG_SECTION = 'antigravityHub';

export class ExtensionConfig {
  private static instance: ExtensionConfig;
  private context: vscode.ExtensionContext | null = null;

  private constructor() {}

  static getInstance(): ExtensionConfig {
    if (!ExtensionConfig.instance) {
      ExtensionConfig.instance = new ExtensionConfig();
    }
    return ExtensionConfig.instance;
  }

  /**
   * Must be called once during activation with the extension context.
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  /**
   * Get the current display language code (e.g., 'en', 'ar')
   */
  getLanguage(): string {
    return this.getConfig().get<string>('language', 'auto');
  }

  /**
   * Whether automatic balance refresh on panel open is enabled
   */
  isAutoRefreshEnabled(): boolean {
    return this.getConfig().get<boolean>('autoRefreshEnabled', true);
  }

  /**
   * Get the refresh interval in minutes
   */
  getRefreshIntervalMinutes(): number {
    return this.getConfig().get<number>('refreshIntervalMinutes', 15);
  }

  /**
   * Get the low credit warning threshold
   */
  getLowCreditThreshold(): number {
    return this.getConfig().get<number>('lowCreditThreshold', 100);
  }

  /**
   * Get the extension context (for services that need it)
   */
  getContext(): vscode.ExtensionContext {
    if (!this.context) {
      throw new Error('ExtensionConfig not initialized. Call initialize() first.');
    }
    return this.context;
  }

  private getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }
}
