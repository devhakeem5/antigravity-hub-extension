/**
 * Path Utilities
 * 
 * Provides cross-platform path resolution for Antigravity's internal directories.
 * Ensures the extension works identically on Windows, macOS, and Linux.
 */

import * as os from 'os';
import * as path from 'path';

export class PathUtils {
  /**
   * Gets the root data directory for Antigravity based on the OS.
   * - Windows: %APPDATA%\Antigravity
   * - macOS: ~/Library/Application Support/Antigravity
   * - Linux: ~/.config/Antigravity
   */
  static getAntigravityDataPath(): string {
    const platform = os.platform();
    const homeDir = os.homedir();

    switch (platform) {
      case 'win32':
        // Fallback to constructed path if APPDATA is somehow missing
        const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
        return path.join(appData, 'Antigravity');
      
      case 'darwin':
        return path.join(homeDir, 'Library', 'Application Support', 'Antigravity');
      
      case 'linux':
        // Respect XDG_CONFIG_HOME if set, otherwise default to ~/.config
        const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
        return path.join(configHome, 'Antigravity');
        
      default:
        throw new Error(`Unsupported operating system: ${platform}`);
    }
  }

  /**
   * Gets the path to the SQLite state database where Antigravity stores OAuth tokens.
   */
  static getVscdbPath(): string {
    return path.join(this.getAntigravityDataPath(), 'User', 'globalStorage', 'state.vscdb');
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
    return path.join(this.getAntigravityDataPath(), 'storage.json');
  }
}
