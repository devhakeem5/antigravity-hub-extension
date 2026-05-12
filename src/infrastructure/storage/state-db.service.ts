/**
 * State Database Service
 * 
 * Injects Protobuf-encoded OAuth tokens into the Antigravity state.vscdb
 * SQLite database to perform seamless account switching.
 * 
 * KEY DESIGN: Antigravity caches state.vscdb in memory and overwrites
 * the file on shutdown. Direct file writes while Antigravity is running
 * are always lost. Therefore we:
 *   1. Spawn a detached "inject-worker" process
 *   2. Close the Antigravity window (which triggers its flush)
 *   3. The worker waits for the file to stabilize, then overwrites it
 *   4. Antigravity relaunches and reads the new data
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger } from '../../core/utils/logger';
import { I18nService } from '../../i18n/i18n.service';
import { PathUtils } from '../../core/utils/path.utils';
import { ProtobufUtils } from '../../core/utils/protobuf.utils';
import { Account, AccountTokens } from '../../core/domain/models/account.model';
import { DeviceProfile } from '../../core/domain/models/device-profile.model';
import { STATE_DB_KEYS, STORAGE_JSON_KEYS, PERSONAL_EMAIL_DOMAINS } from '../../core/constants/app.constants';
import { getAntigravityVersion, isVersionSupported, MIN_SUPPORTED_VERSION } from '../../core/utils/version.utils';

export class StateDbService {

  constructor(private readonly context?: vscode.ExtensionContext) { }

  // ─── Main Injection Orchestrator ─────────────────────────────────────────────

  async injectAccountState(
    account: Account,
    tokens: AccountTokens,
    deviceProfile?: DeviceProfile | null
  ): Promise<'success' | 'cancelled' | 'error'> {
    const versionCheckResult = this.checkAntigravityVersion();
    if (versionCheckResult === 'unsupported') {
      const i18n = I18nService.getInstance();
      vscode.window.showErrorMessage(
        i18n.t('stateDb.outdatedAntigravity', { minVersion: MIN_SUPPORTED_VERSION }),
        { modal: true }
      );
      return 'error';
    }

    const dbPath = PathUtils.getVscdbPath();
    if (!fs.existsSync(dbPath)) {
      const i18n = I18nService.getInstance();
      Logger.getInstance().error(`State database not found at ${dbPath}`);
      vscode.window.showErrorMessage(
        i18n.t('stateDb.dbNotFound')
      );
      return 'error';
    }

    try {
      // ── Step 1: Rolling Backup ──
      this.performRollingBackup(dbPath);

      // ── Step 2: Write device profile to storage.json ──
      if (deviceProfile) {
        this.writeDeviceProfileToStorageJson(deviceProfile);
      }

      // ── Step 3: Build payloads ──
      const isGcpTos = this.shouldEnableGcpTos(account.email);

      const oauthToken = ProtobufUtils.createUnifiedOAuthToken(
        tokens.accessToken, tokens.refreshToken, tokens.expiresAt,
        isGcpTos, undefined, account.email
      );

      const userStatusPayload = ProtobufUtils.createMinimalUserStatusPayload(account.email);
      const userStatus = ProtobufUtils.createUnifiedStateEntry('userStatusSentinelKey', userStatusPayload);

      const enterpriseEntry = account.projectId
        ? ProtobufUtils.createUnifiedStateEntry(
          'enterpriseGcpProjectId',
          ProtobufUtils.createStringValuePayload(account.projectId))
        : undefined;

      // Build the row list for the worker
      const rows: Array<{ key: string; value: string | null }> = [
        { key: STATE_DB_KEYS.OAUTH_TOKEN, value: oauthToken },
        { key: STATE_DB_KEYS.USER_STATUS, value: userStatus },
        { key: STATE_DB_KEYS.ONBOARDING, value: 'true' },
        { key: STATE_DB_KEYS.LEGACY, value: null }, // delete
      ];
      if (enterpriseEntry) {
        rows.push({ key: STATE_DB_KEYS.ENTERPRISE_PREFS, value: enterpriseEntry });
      }
      if (deviceProfile) {
        // Inject ALL telemetry fingerprint keys to prevent cross-account correlation.
        // Without this, shared values (e.g. firstSessionDate, storage.serviceMachineId)
        // allow Google to link multiple accounts to the same physical device.
        rows.push({ key: STATE_DB_KEYS.TELEMETRY_SERVICE_MACHINE_ID, value: deviceProfile.macMachineId });
        rows.push({ key: STATE_DB_KEYS.STORAGE_SERVICE_MACHINE_ID, value: deviceProfile.devDeviceId });
        rows.push({ key: STATE_DB_KEYS.TELEMETRY_FIRST_SESSION_DATE, value: deviceProfile.firstSessionDate });
        // Reset current/last session dates to "now" so each switch looks like a fresh session
        const nowUtc = new Date().toUTCString();
        rows.push({ key: STATE_DB_KEYS.TELEMETRY_CURRENT_SESSION_DATE, value: nowUtc });
        rows.push({ key: STATE_DB_KEYS.TELEMETRY_LAST_SESSION_DATE, value: nowUtc });
      }

      // ── Step 4: Spawn background worker + close window ──
      const triggered = await this.triggerWorkerAndClose(account.email, dbPath, rows);
      return triggered ? 'success' : 'cancelled';

    } catch (error: any) {
      const i18n = I18nService.getInstance();
      Logger.getInstance().error('Failed to inject state into state.vscdb', error);
      vscode.window.showErrorMessage(
        i18n.t('stateDb.injectionFailed', { error: error.message })
      );
      return 'error';
    }
  }

  // ─── Worker-based injection ─────────────────────────────────────────────────

  private async triggerWorkerAndClose(
    email: string,
    dbPath: string,
    rows: Array<{ key: string; value: string | null }>
  ): Promise<boolean> {
    const i18n = I18nService.getInstance();
    const actionYes = i18n.t('switchPrompt.actionYes');
    const actionNo = i18n.t('switchPrompt.actionNo');

    const choice = await vscode.window.showInformationMessage(
      i18n.t('switchPrompt.title', { email }),
      {
        modal: true,
        detail: i18n.t('stateDb.reloadPrompt'),
      },
      actionYes,
      actionNo
    );

    if (choice !== actionYes) {
      Logger.getInstance().info('User cancelled account switch.');
      return false;
    }

    // Save open files before closing
    try {
      const filesConfig = vscode.workspace.getConfiguration('files');
      await vscode.workspace.saveAll(filesConfig.get<string>('autoSave') === 'off');
    } catch (e) { /* best effort */ }

    const antigravityExe = this.findAntigravityExe();
    // process.execPath inside Antigravity IS the Antigravity binary itself
    const currentExePath = process.execPath;
    const workDir = __dirname;
    const payloadPath = path.join(workDir, '.inject-payload.json');
    const workerPath = path.join(workDir, '.inject-worker.js');

    // Collect all candidate exe paths for relaunch (deduplicated)
    const exeCandidates: string[] = [];
    if (antigravityExe) exeCandidates.push(antigravityExe);
    if (currentExePath && !exeCandidates.includes(currentExePath)) exeCandidates.push(currentExePath);

    const payloadObj = { dbPath, rows, exeCandidates };

    fs.writeFileSync(payloadPath, JSON.stringify(payloadObj, null, 2), 'utf-8');
    fs.writeFileSync(workerPath, this.getWorkerScript(), 'utf-8');

    Logger.getInstance().info(`Spawning inject-worker. Payload: ${payloadPath}, candidates: ${exeCandidates.join(', ')}`);

    // CRITICAL: process.execPath inside Antigravity IS the Antigravity.exe (Electron binary).
    // Without ELECTRON_RUN_AS_NODE=1, it will try to open the worker script as a
    // workspace/file instead of executing it as Node.js. This env var tells Electron
    // to behave as a plain Node.js runtime.
    const workerEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

    // Spawn detached worker — survives after this process closes
    const child = spawn(process.execPath, [workerPath, payloadPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: workDir,
      env: workerEnv,
    });
    child.unref();

    Logger.getInstance().info(`Worker spawned (PID ${child.pid}). Closing window...`);

    // Close window → Antigravity flushes state.vscdb and exits.
    // The worker will wait for all Antigravity processes to exit, then overwrite.
    vscode.commands.executeCommand('workbench.action.closeWindow');
    return true;
  }

  /**
   * Returns the worker script that runs AFTER Antigravity has fully exited.
   *
   * Flow:
   *   1. Polls for any running Antigravity.exe processes (excluding own PID)
   *   2. Waits until none remain (meaning the flush completed)
   *   3. Waits a safety margin for OS file lock release
   *   4. Injects new data into state.vscdb
   *   5. Relaunches Antigravity
   */
  private getWorkerScript(): string {
    return `
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const LOG_PATH = process.argv[2] + '.worker.log';
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  try { fs.appendFileSync(LOG_PATH, line + '\\n'); } catch {}
}

const payloadPath = process.argv[2];
if (!payloadPath || !fs.existsSync(payloadPath)) {
  log('No payload file found at: ' + process.argv[2]);
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf-8'));
const { dbPath, rows, exeCandidates } = payload;
const ownPid = process.pid;

log('Worker started. Own PID: ' + ownPid);
log('DB Path: ' + dbPath);
log('Exe candidates: ' + JSON.stringify(exeCandidates));
log('ELECTRON_RUN_AS_NODE: ' + process.env.ELECTRON_RUN_AS_NODE);

// ── Helper: check if any Antigravity.exe processes are running (excluding self) ──
function getOtherAntigravityPids() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /FO CSV /NH', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = [];
    for (const line of out.split('\\n')) {
      const match = line.match(/"Antigravity\\.exe","(\\d+)"/i);
      if (match) {
        const pid = parseInt(match[1], 10);
        if (pid !== ownPid) pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

// ── Wait for all Antigravity processes to exit ──
async function waitForAntigravityExit(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pids = getOtherAntigravityPids();
    if (pids.length === 0) {
      log('All Antigravity processes have exited.');
      return true;
    }
    log('Waiting... remaining PIDs: ' + pids.join(', '));
    await new Promise(r => setTimeout(r, 500));
  }
  log('Timeout waiting for Antigravity to exit.');
  return false;
}

// ── Force-kill specific PIDs (by PID number, NOT by image name) ──
// This is safe because we only kill PIDs we know are lingering Antigravity
// processes, never our own worker PID.
function forceKillRemainingPids() {
  const pids = getOtherAntigravityPids();
  if (pids.length === 0) return;
  log('Force-killing remaining PIDs: ' + pids.join(', '));
  for (const pid of pids) {
    try {
      execSync('taskkill /F /PID ' + pid, { stdio: 'ignore', windowsHide: true });
      log('  Killed PID ' + pid);
    } catch (e) {
      log('  Failed to kill PID ' + pid + ': ' + String(e));
    }
  }
  // Verify all gone
  const remaining = getOtherAntigravityPids();
  if (remaining.length > 0) {
    log('WARNING: Some PIDs survived force-kill: ' + remaining.join(', '));
  } else {
    log('All lingering processes killed successfully.');
  }
}

// ── Find best exe path to relaunch ──
function findRelaunchExe() {
  // Try payload candidates first
  if (exeCandidates && Array.isArray(exeCandidates)) {
    for (const candidate of exeCandidates) {
      if (candidate && fs.existsSync(candidate)) {
        log('Found relaunch exe from candidates: ' + candidate);
        return candidate;
      }
    }
  }

  // Fallback: scan common installation paths on Windows
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.PROGRAMFILES || '';
  const fallbacks = [
    path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
    path.join(programFiles, 'Antigravity', 'Antigravity.exe'),
  ];
  for (const p of fallbacks) {
    if (p && fs.existsSync(p)) {
      log('Found relaunch exe from fallback: ' + p);
      return p;
    }
  }

  log('No relaunch exe found in any candidate or fallback path.');
  return null;
}

async function inject() {
  // Phase 1: Wait up to 5s for Antigravity to flush and gracefully exit
  // (The log showed most processes exit within ~2 seconds)
  const exited = await waitForAntigravityExit(5000);

  if (!exited) {
    // Phase 2: Force-kill any lingering processes by their specific PIDs
    // (NOT by image name — that would kill our worker too!)
    // These are typically GPU helper or utility processes that hold the
    // single-instance lock and prevent relaunch.
    log('Graceful exit incomplete. Force-killing remaining processes...');
    forceKillRemainingPids();
  }

  // Phase 3: Safety margin for OS to release file locks
  await new Promise(r => setTimeout(r, 1500));

  log('Loading sql.js...');
  let initSqlJs;
  try {
    initSqlJs = require('sql.js');
  } catch {
    try {
      initSqlJs = require(path.join(__dirname, '..', 'node_modules', 'sql.js'));
    } catch {
      initSqlJs = require(path.join(__dirname, '..', '..', 'node_modules', 'sql.js'));
    }
  }

  log('Opening database: ' + dbPath);
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  try {
    for (const { key, value } of rows) {
      if (value === null) {
        db.run('DELETE FROM ItemTable WHERE key = ?', [key]);
        log('  DELETED: ' + key);
      } else {
        db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [key, value]);
        log('  INJECTED: ' + key + ' (' + value.length + ' chars)');
      }
    }
    const out = db.export();
    fs.writeFileSync(dbPath, Buffer.from(out));
    log('Database saved.');
  } finally {
    db.close();
  }

  // Cleanup payload file
  try { fs.unlinkSync(payloadPath); } catch {}

  // ── Relaunch Antigravity ──
  const relaunchExe = findRelaunchExe();
  if (relaunchExe) {
    log('Relaunching Antigravity: ' + relaunchExe);

    // Write a .bat file that explicitly clears ELECTRON_RUN_AS_NODE then launches.
    // This is deterministic — unlike Node env options, a .bat controls its own env.
    const batPath = path.join(path.dirname(payloadPath), '.relaunch-antigravity.bat');
    const batLines = ['@echo off', 'set ELECTRON_RUN_AS_NODE=', 'start "" "' + relaunchExe + '"', 'del "%~f0"'];
    fs.writeFileSync(batPath, batLines.join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10), 'utf-8');
    log('Wrote relaunch .bat to: ' + batPath);

    try {
      const child = spawn('cmd.exe', ['/c', batPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      log('Relaunch .bat spawned, PID: ' + child.pid);
    } catch (batErr) {
      log('Relaunch .bat failed: ' + String(batErr));
      try {
        execSync(
          'powershell -NoProfile -Command "Remove-Item Env:ELECTRON_RUN_AS_NODE -EA SilentlyContinue; Start-Process ' + relaunchExe + '"',
          { stdio: 'ignore', windowsHide: true }
        );
        log('Relaunch via PowerShell succeeded.');
      } catch (psErr) {
        log('ALL relaunch methods failed: ' + String(psErr));
      }
    }
  } else {
    log('ERROR: Antigravity exe not found, cannot relaunch.');
  }

  log('Worker finished successfully.');
  await new Promise(r => setTimeout(r, 3000));
}

inject().catch((err) => {
  log('FATAL: ' + String(err));
  process.exit(1);
});
`;
  }

  private findAntigravityExe(): string | undefined {
    if (process.platform === 'win32') {
      const candidates = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Antigravity', 'Antigravity.exe'),
      ];
      return candidates.find(c => fs.existsSync(c));
    }
    return undefined;
  }

  // ─── Read Current Active Account from state.vscdb ──────────────────────────

  /**
   * Reads the currently active email from Antigravity's state.vscdb.
   * This allows the extension to detect which account Antigravity is currently
   * using, even if it was switched outside this extension.
   * 
   * Returns null if the database doesn't exist or the email can't be extracted.
   */
  async readCurrentEmailFromDb(): Promise<string | null> {
    const dbPath = PathUtils.getVscdbPath();
    if (!fs.existsSync(dbPath)) {
      Logger.getInstance().info('state.vscdb not found, cannot detect active account.');
      return null;
    }

    try {
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      const buf = fs.readFileSync(dbPath);
      const db = new SQL.Database(buf);

      try {
        // Read the userStatus entry which contains the email
        // sql.js uses prepare/bind for parameterized queries
        const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = $key');
        stmt.bind({ $key: STATE_DB_KEYS.USER_STATUS });

        if (!stmt.step()) {
          stmt.free();
          Logger.getInstance().info('No userStatus entry found in state.vscdb.');
          return null;
        }

        const row = stmt.get();
        stmt.free();

        const base64Value = row[0] as string;
        if (!base64Value) return null;

        // Decode the protobuf chain to extract the email
        const email = this.extractEmailFromUserStatus(base64Value);
        if (email) {
          Logger.getInstance().info(`Detected active Antigravity account: ${email}`);
        }
        return email;
      } finally {
        db.close();
      }
    } catch (error: any) {
      Logger.getInstance().error('Failed to read active account from state.vscdb', error);
      throw error;
    }
  }

  /**
   * Extracts the email from a base64-encoded userStatus protobuf.
   * The structure is: Topic → DataEntry → Row → UserStatus payload.
   * The email is stored in field 3 and field 7 of the UserStatus payload.
   */
  private extractEmailFromUserStatus(base64Value: string): string | null {
    try {
      // Level 1: Decode outer Topic (base64 → bytes)
      const topicBytes = Buffer.from(base64Value, 'base64');
      
      // Level 2: Parse Topic → extract DataEntry (field 1, wire type 2)
      const dataEntryBytes = this.extractField(topicBytes, 1);
      if (!dataEntryBytes) return null;

      // Level 3: Parse DataEntry → extract Row (field 2, wire type 2)
      const rowBytes = this.extractField(dataEntryBytes, 2);
      if (!rowBytes) return null;

      // Level 4: Parse Row → extract base64 value (field 1, string)
      const innerBase64 = this.extractStringField(rowBytes, 1);
      if (!innerBase64) return null;

      // Level 5: Decode inner payload (base64 → UserStatus protobuf)
      const userStatusBytes = Buffer.from(innerBase64, 'base64');

      // Level 6: Extract email from UserStatus (field 3 or field 7)
      const emailField3 = this.extractStringField(userStatusBytes, 3);
      const emailField7 = this.extractStringField(userStatusBytes, 7);
      
      return emailField3 || emailField7 || null;
    } catch (e) {
      Logger.getInstance().error('Failed to parse userStatus protobuf', e);
      return null;
    }
  }

  /**
   * Extracts a length-delimited field (wire type 2) from protobuf bytes.
   */
  private extractField(data: Buffer, fieldNum: number): Buffer | null {
    let offset = 0;
    while (offset < data.length) {
      const { value: tag, bytesRead: tagLen } = this.readVarint(data, offset);
      offset += tagLen;
      
      const wireType = tag & 0x07;
      const num = tag >> 3;

      if (wireType === 2) {
        const { value: len, bytesRead: lenLen } = this.readVarint(data, offset);
        offset += lenLen;
        if (num === fieldNum) {
          return data.slice(offset, offset + len);
        }
        offset += len;
      } else if (wireType === 0) {
        const { bytesRead } = this.readVarint(data, offset);
        offset += bytesRead;
      } else {
        break; // Unknown wire type
      }
    }
    return null;
  }

  /**
   * Extracts a string field (wire type 2, interpreted as UTF-8) from protobuf bytes.
   */
  private extractStringField(data: Buffer, fieldNum: number): string | null {
    const fieldData = this.extractField(data, fieldNum);
    if (!fieldData) return null;
    return fieldData.toString('utf-8');
  }

  /**
   * Reads a varint from a buffer at the given offset.
   */
  private readVarint(buf: Buffer, offset: number): { value: number; bytesRead: number } {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;
    while (offset < buf.length) {
      const byte = buf[offset];
      value |= (byte & 0x7F) << shift;
      offset++;
      bytesRead++;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return { value, bytesRead };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private checkAntigravityVersion(): 'supported' | 'unsupported' | 'unknown' {
    const version = getAntigravityVersion();
    if (!version) {
      Logger.getInstance().warn('Could not detect Antigravity version.');
      return 'unknown';
    }
    Logger.getInstance().info(`Detected Antigravity version: ${version.short}`);
    return isVersionSupported(version) ? 'supported' : 'unsupported';
  }

  private writeDeviceProfileToStorageJson(profile: DeviceProfile): void {
    const storagePath = PathUtils.getStorageJsonPath();
    try {
      let storageData: Record<string, any> = {};
      if (fs.existsSync(storagePath)) {
        try { storageData = JSON.parse(fs.readFileSync(storagePath, 'utf-8')); }
        catch { storageData = {}; }
      } else {
        const dir = path.dirname(storagePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      storageData[STORAGE_JSON_KEYS.MACHINE_ID] = profile.machineId;
      storageData[STORAGE_JSON_KEYS.MAC_MACHINE_ID] = profile.macMachineId;
      storageData[STORAGE_JSON_KEYS.DEV_DEVICE_ID] = profile.devDeviceId;
      storageData[STORAGE_JSON_KEYS.SQM_ID] = profile.sqmId;
      storageData[STORAGE_JSON_KEYS.SERVICE_MACHINE_ID] = profile.devDeviceId;
      fs.writeFileSync(storagePath, JSON.stringify(storageData, null, 2), 'utf-8');
      Logger.getInstance().info('Device profile written to storage.json');
    } catch (e: any) {
      Logger.getInstance().error(`Failed to write device profile: ${e.message}`, e);
    }
  }

  private shouldEnableGcpTos(email: string): boolean {
    const lowerEmail = email.toLowerCase();
    return !PERSONAL_EMAIL_DOMAINS.some((d: string) => lowerEmail.endsWith(d));
  }

  private performRollingBackup(dbPath: string): void {
    const maxBackups = 5;
    try {
      for (let i = maxBackups - 1; i >= 1; i--) {
        const curr = `${dbPath}.backup.${i}`;
        const next = `${dbPath}.backup.${i + 1}`;
        if (fs.existsSync(curr)) fs.renameSync(curr, next);
      }
      fs.copyFileSync(dbPath, `${dbPath}.backup.1`);
    } catch (e) {
      Logger.getInstance().error('Failed to create backup', e);
    }
  }
}
