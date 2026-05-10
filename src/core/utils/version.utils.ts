/**
 * Version Utilities
 * 
 * Detects the installed Antigravity editor version.
 * Used to determine which token injection format to use.
 * 
 * Minimum supported version: 1.16.5 (Unified State Sync format)
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { Logger } from '../utils/logger';

export const MIN_SUPPORTED_VERSION = '1.16.5';

export interface AntigravityVersion {
  full: string;
  short: string; // e.g., "1.22.2"
}

/**
 * Attempts to detect the installed Antigravity version.
 * Strategy depends on the operating system.
 * Returns null if detection fails.
 */
export function getAntigravityVersion(): AntigravityVersion | null {
  try {
    const platform = os.platform();

    if (platform === 'win32') {
      return detectVersionWindows();
    } else if (platform === 'darwin') {
      return detectVersionMacOS();
    } else {
      return detectVersionLinux();
    }
  } catch (e) {
    Logger.getInstance().warn('Failed to detect Antigravity version', e);
    return null;
  }
}

/**
 * Compares a version string against the minimum supported version.
 * Returns true if the version is >= MIN_SUPPORTED_VERSION (1.16.5).
 */
export function isVersionSupported(version: AntigravityVersion): boolean {
  return compareVersions(version.short, MIN_SUPPORTED_VERSION) >= 0;
}

/**
 * Semantic version comparison.
 * Returns: -1 (a < b), 0 (a == b), 1 (a > b)
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

// ─── Platform-Specific Detection ────────────────────────────────────────────

function detectVersionWindows(): AntigravityVersion | null {
  // Try to find Antigravity executable and read its FileVersion via PowerShell
  const possiblePaths = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Antigravity', 'Antigravity.exe'),
  ];

  for (const exePath of possiblePaths) {
    if (fs.existsSync(exePath)) {
      try {
        const output = execSync(
          `powershell -NoProfile -Command "(Get-Item '${exePath}').VersionInfo.FileVersion"`,
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();

        if (output && /^\d+\.\d+/.test(output)) {
          return { full: output, short: extractShortVersion(output) };
        }
      } catch (e) {
        Logger.getInstance().debug(`Failed to read version from ${exePath}`);
      }
    }
  }
  return null;
}

function detectVersionMacOS(): AntigravityVersion | null {
  const plistPath = '/Applications/Antigravity.app/Contents/Info.plist';
  if (fs.existsSync(plistPath)) {
    try {
      const output = execSync(
        `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${plistPath}"`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      if (output && /^\d+\.\d+/.test(output)) {
        return { full: output, short: extractShortVersion(output) };
      }
    } catch (e) {
      Logger.getInstance().debug('Failed to read version from Info.plist');
    }
  }
  return null;
}

function detectVersionLinux(): AntigravityVersion | null {
  // Try command line --version
  const binaryNames = ['antigravity', 'Antigravity'];
  for (const name of binaryNames) {
    try {
      const output = execSync(`${name} --version 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      // Extract version number from output like "Antigravity 1.22.2"
      const match = output.match(/(\d+\.\d+\.\d+)/);
      if (match) {
        return { full: output, short: match[1] };
      }
    } catch (e) {
      // Binary not found or not in PATH, try next
    }
  }
  return null;
}

function extractShortVersion(fullVersion: string): string {
  const match = fullVersion.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : fullVersion;
}
