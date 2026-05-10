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
  };
}
