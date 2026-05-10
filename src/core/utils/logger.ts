/**
 * Logger — Centralized logging utility
 *
 * Uses VS Code's OutputChannel for extension logs.
 * Implements Singleton pattern for global access.
 */

import * as vscode from 'vscode';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  private static instance: Logger;
  private outputChannel: vscode.OutputChannel;
  private level: LogLevel = LogLevel.INFO;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Antigravity Hub');
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, ...args: unknown[]): void {
    this.log(LogLevel.DEBUG, message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log(LogLevel.INFO, message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log(LogLevel.WARN, message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log(LogLevel.ERROR, message, ...args);
  }

  /**
   * Show the output channel in the VS Code panel
   */
  show(): void {
    this.outputChannel.show(true);
  }

  dispose(): void {
    this.outputChannel.dispose();
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (level < this.level) {
      return;
    }

    const timestamp = new Date().toISOString();
    const levelTag = LogLevel[level].padEnd(5);
    const formattedArgs = args.length > 0 ? ` | ${JSON.stringify(args)}` : '';
    const line = `[${timestamp}] [${levelTag}] ${message}${formattedArgs}`;

    this.outputChannel.appendLine(line);

    // Also log errors to console for debugging
    if (level === LogLevel.ERROR) {
      console.error(`[Antigravity Hub] ${message}`, ...args);
    }
  }
}
