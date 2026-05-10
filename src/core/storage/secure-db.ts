/**
 * Secure JSON Database
 * 
 * A generic file-based database that stores data securely encrypted on disk.
 * The file is saved directly in the Antigravity OS-specific configuration folder.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CryptoUtils } from '../utils/crypto.utils';
import { PathUtils } from '../utils/path.utils';
import { Logger } from '../utils/logger';

export class SecureDatabase<T extends Record<string, any>> {
  private filePath: string;
  private data: T | null = null;
  private isLoaded = false;

  /**
   * @param filename The name of the file (e.g., 'helper_accounts.enc')
   * @param defaultData Default structure if the file doesn't exist
   */
  constructor(
    private filename: string, 
    private defaultData: T
  ) {
    const basePath = PathUtils.getAntigravityDataPath();
    this.filePath = path.join(basePath, this.filename);
  }

  /**
   * Initializes the database, loading from disk.
   */
  load(): T {
    if (this.isLoaded && this.data) {
      return this.data;
    }

    try {
      if (!fs.existsSync(this.filePath)) {
        this.data = { ...this.defaultData };
        this.isLoaded = true;
        return this.data;
      }

      const encryptedContent = fs.readFileSync(this.filePath, 'utf8');
      const decryptedContent = CryptoUtils.decrypt(encryptedContent);
      this.data = JSON.parse(decryptedContent) as T;
      this.isLoaded = true;
      return this.data;
      
    } catch (error) {
      Logger.getInstance().error(`Failed to load SecureDatabase from ${this.filePath}`, error);
      // Fallback to default data on corruption to prevent app crash
      this.data = { ...this.defaultData };
      this.isLoaded = true;
      return this.data;
    }
  }

  /**
   * Saves the current state of the database securely to disk.
   */
  save(): void {
    if (!this.data) {
      Logger.getInstance().warn(`Attempted to save SecureDatabase before loading: ${this.filename}`);
      return;
    }

    try {
      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const jsonContent = JSON.stringify(this.data);
      const encryptedContent = CryptoUtils.encrypt(jsonContent);
      
      // Write to a temporary file first, then rename for atomic save
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, encryptedContent, 'utf8');
      fs.renameSync(tempPath, this.filePath);
      
    } catch (error) {
      Logger.getInstance().error(`Failed to save SecureDatabase to ${this.filePath}`, error);
      throw error;
    }
  }

  /**
   * Gets the current data object.
   */
  getData(): T {
    if (!this.isLoaded || !this.data) {
      return this.load();
    }
    return this.data;
  }

  /**
   * Updates the database with new partial data and saves it.
   */
  update(partialData: Partial<T>): void {
    const currentData = this.getData();
    this.data = { ...currentData, ...partialData };
    this.save();
  }

  /**
   * Overwrites the database entirely and saves it.
   */
  set(newData: T): void {
    this.data = { ...newData };
    this.save();
  }
}
