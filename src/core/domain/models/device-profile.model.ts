/**
 * Device Profile Model
 * 
 * Represents a unique device fingerprint tied to each account.
 * Antigravity's server validates that the OAuth token matches the device fingerprint.
 * Each account gets its own unique profile to avoid cross-account detection.
 */

import * as crypto from 'crypto';

export interface DeviceProfile {
  /** Format: "auth0|user_<32 hex chars>" */
  machineId: string;
  /** Random UUID (lowercase) */
  macMachineId: string;
  /** UUID v4 standard */
  devDeviceId: string;
  /** UUID uppercase in braces: "{XXXXXXXX-XXXX-...}" */
  sqmId: string;
  /** Unique "first session" date per account to prevent session date correlation */
  firstSessionDate: string;
}

/**
 * Generates a brand-new unique device fingerprint.
 * Called once per account during initial setup.
 */
export function generateDeviceProfile(): DeviceProfile {
  return {
    machineId: `auth0|user_${crypto.randomBytes(16).toString('hex')}`,
    macMachineId: crypto.randomUUID(),
    devDeviceId: crypto.randomUUID(),
    sqmId: `{${crypto.randomUUID().toUpperCase()}}`,
    firstSessionDate: generatePlausibleFirstSessionDate(),
  };
}

/**
 * Generates a plausible "first session" date string for a new account.
 * Random date between 30 and 90 days in the past (UTC), formatted as
 * the HTTP date string Antigravity uses (e.g. "Tue, 21 Apr 2026 02:20:41 GMT").
 */
export function generatePlausibleFirstSessionDate(): string {
  const now = Date.now();
  const minDaysAgo = 30;
  const maxDaysAgo = 90;
  const daysAgo = minDaysAgo + Math.floor(Math.random() * (maxDaysAgo - minDaysAgo + 1));
  const randomMs = Math.floor(Math.random() * 86400000); // random time within the day
  const date = new Date(now - daysAgo * 86400000 + randomMs);
  return date.toUTCString();
}
