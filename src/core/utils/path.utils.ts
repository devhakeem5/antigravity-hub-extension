/**
 * Path Utilities
 * 
 * Provides cross-platform path resolution for Antigravity's internal directories.
 * Ensures the extension works identically on Windows, macOS, and Linux.
 */

import * as path from 'path';
import { AntigravityProduct, detectAntigravityProduct } from './antigravity-product.utils';

export class PathUtils {
  /**
   * Gets the root data directory for Antigravity based on the OS.
   * - Windows: %APPDATA%\Antigravity
   * - macOS: ~/Library/Application Support/Antigravity
   * - Linux: ~/.config/Antigravity
   */
  static getAntigravityDataPath(): string {
    return this.getAntigravityProduct().dataPath;
  }

  static getAntigravityProduct(): AntigravityProduct {
    return detectAntigravityProduct();
  }

  /**
   * Gets the path to the SQLite state database where Antigravity stores OAuth tokens.
   */
  static getVscdbPath(): string {
    return this.getAntigravityProduct().stateDbPath;
  }

  /**
   * Checks if a path is absolute, if not resolves it against the extension root.
   */
  static resolveExtensionPath(extensionPath: string, relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return path.join(extensionPath, relativePath);
  }

  /**
   * Gets the path to storage.json where Antigravity stores telemetry fingerprints.
   * This file sits alongside state.vscdb in the globalStorage directory.
   */
  static getStorageJsonPath(): string {
    return this.getAntigravityProduct().storageJsonPath;
  }
}
