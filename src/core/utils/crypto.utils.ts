/**
 * Crypto Utilities
 * 
 * Provides robust AES-256-GCM encryption/decryption.
 * The encryption key is derived dynamically using PBKDF2 based on the VS Code
 * machine ID, ensuring data cannot be easily extracted and read on another machine.
 */

import * as crypto from 'crypto';
import * as vscode from 'vscode';

export class CryptoUtils {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly SALT = 'antigravity_hub_secure_salt_v1';
  private static readonly ITERATIONS = 100000;
  private static readonly KEY_LENGTH = 32; // 256 bits for AES-256

  /**
   * Derives a machine-specific encryption key.
   */
  private static getEncryptionKey(): Buffer {
    // vscode.env.machineId is unique per machine and OS installation
    const machineId = vscode.env.machineId;
    return crypto.pbkdf2Sync(
      machineId,
      this.SALT,
      this.ITERATIONS,
      this.KEY_LENGTH,
      'sha256'
    );
  }

  /**
   * Encrypts a plaintext string using AES-256-GCM.
   * @returns A colon-separated string: iv:authTag:encryptedData (hex encoded)
   */
  static encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12); // Standard length for GCM
    const key = this.getEncryptionKey();
    
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag().toString('hex');
    
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypts AES-256-GCM encrypted string.
   * @param encryptedData Must be in format iv:authTag:encryptedData
   */
  static decrypt(encryptedData: string): string {
    const parts = encryptedData.split(':');
    
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format. Expected iv:authTag:data');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encryptedText = parts[2];
    const key = this.getEncryptionKey();
    
    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
}
