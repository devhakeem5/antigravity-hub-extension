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
 *
 * NEW ANTIGRAVITY IDE (agent hub architecture):
 *   The AI agent now runs in a separate backend process (`agy.exe --hub`) that
 *   loads its OAuth token from the OS keyring (Credential Manager entry
 *   "gemini:antigravity") instead of state.vscdb. Injecting state.vscdb alone
 *   therefore left the agent on the OLD account. The worker now also:
 *     - stops the hub processes spawned by the closing IDE (they cache + re-save tokens)
 *     - writes the new account into the keyring credential
 *     - updates the built-in extension's onboarding state (google.google-antigravity)
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
import { randomBytes } from 'crypto';
import {
  STATE_DB_KEYS,
  STORAGE_JSON_KEYS,
  PERSONAL_EMAIL_DOMAINS,
  AGY_CREDENTIAL,
  EXTENSION_STATE_KEYS,
} from '../../core/constants/app.constants';

/** Credential that the agent hub (agy.exe) loads from the OS keyring. */
interface AgyCredentialPayload {
  target: string;
  userName: string;
  /** JSON blob in the exact format agy writes itself. */
  value: string;
}

/** Patch applied to the built-in extension's JSON state (google.google-antigravity). */
interface ExtensionStatePatch {
  key: string;
  storageRoot: string;
  values: Record<string, string>;
}

/**
 * PowerShell script that writes a Generic credential into the Windows Credential
 * Manager. The secret is read from the file referenced by $env:AGY_CRED_FILE so
 * tokens never appear on a command line.
 */
const AGY_CREDENTIAL_WRITER_PS = [
  "$ErrorActionPreference = 'Stop'",
  "$src = @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class AgyHubCredWriter {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct CREDENTIAL {',
  '    public int Flags; public int Type; public string TargetName; public string Comment;',
  '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;',
  '    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
  '  }',
  '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  static extern bool CredWrite(ref CREDENTIAL credential, int flags);',
  '  public static void Write(string target, string user, string secret) {',
  '    byte[] blob = Encoding.UTF8.GetBytes(secret);',
  '    CREDENTIAL c = new CREDENTIAL();',
  '    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;',
  '    c.CredentialBlobSize = blob.Length;',
  '    c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);',
  '    try {',
  '      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);',
  '      if (!CredWrite(ref c, 0)) { throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }',
  '    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }',
  '  }',
  '}',
  "'@",
  'Add-Type -TypeDefinition $src',
  '$data = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:AGY_CRED_FILE | ConvertFrom-Json',
  '[AgyHubCredWriter]::Write($data.target, $data.userName, $data.value)',
  "Write-Output 'AGY_CREDENTIAL_WRITTEN'",
].join('\r\n');
import { getAntigravityVersion, isVersionSupported, MIN_SUPPORTED_VERSION } from '../../core/utils/version.utils';

export class StateDbService {

  constructor(private readonly context?: vscode.ExtensionContext) { }

  // ─── Main Injection Orchestrator ─────────────────────────────────────────────

  async injectAccountState(
    account: Account,
    tokens: AccountTokens,
    deviceProfile?: DeviceProfile | null
  ): Promise<'success' | 'cancelled' | 'error'> {
    const product = PathUtils.getAntigravityProduct();
    const versionCheckResult = this.checkAntigravityVersion();
    if (versionCheckResult === 'unsupported') {
      const i18n = I18nService.getInstance();
      vscode.window.showErrorMessage(
        i18n.t('stateDb.outdatedAntigravity', { minVersion: MIN_SUPPORTED_VERSION }),
        { modal: true }
      );
      return 'error';
    }

    const dbPath = product.stateDbPath;
    if (!fs.existsSync(dbPath)) {
      const i18n = I18nService.getInstance();
      Logger.getInstance().error(`State database not found at ${dbPath}`);
      vscode.window.showErrorMessage(
        i18n.t('stateDb.dbNotFound')
      );
      return 'error';
    }

    try {
      this.validateTargetPath(product.dataPath, dbPath);
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

      // ── Step 4: Agent hub keyring credential + built-in extension onboarding state ──
      const agyCredential = this.buildAgyCredential(account.email, tokens, isGcpTos);
      const extensionStatePatch: ExtensionStatePatch = {
        key: STATE_DB_KEYS.EXTENSION_STATE,
        storageRoot: EXTENSION_STATE_KEYS.STORAGE_ROOT,
        values: {
          [EXTENSION_STATE_KEYS.LAST_LOGIN_USERNAME]: account.email,
          [EXTENSION_STATE_KEYS.LAST_LOGIN_IS_GCP_TOS]: String(isGcpTos),
        },
      };

      // ── Step 5: Spawn background worker + close window ──
      const triggered = await this.triggerWorkerAndClose(
        account.email,
        dbPath,
        rows,
        product.executablePath || process.execPath,
        product.processName,
        product.displayName,
        agyCredential,
        extensionStatePatch
      );
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
    rows: Array<{ key: string; value: string | null }>,
    executablePath: string,
    processName: string,
    productName: string,
    agyCredential: AgyCredentialPayload | null = null,
    extensionStatePatch: ExtensionStatePatch | null = null
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

    const workDir = __dirname;
    const payloadPath = path.join(workDir, '.inject-payload.json');
    const workerPath = path.join(workDir, '.inject-worker.js');

    const payloadObj = {
      dbPath,
      rows,
      executablePath,
      processName,
      productName,
      extensionStatePatch,
      agyCredential,
      agyProcessName: AGY_CREDENTIAL.PROCESS_NAME,
      credentialWriterScript: agyCredential ? AGY_CREDENTIAL_WRITER_PS : null,
    };

    fs.writeFileSync(payloadPath, JSON.stringify(payloadObj, null, 2), 'utf-8');
    fs.writeFileSync(workerPath, this.getWorkerScript(), 'utf-8');

    Logger.getInstance().info(
      `Spawning inject-worker for ${productName}. DB: ${dbPath}, process: ${processName}, exe: ${executablePath}`
    );

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
const { dbPath, rows, executablePath, processName, productName } = payload;
const extensionStatePatch = payload.extensionStatePatch || null;
const agyCredential = payload.agyCredential || null;
const agyProcessName = String(payload.agyProcessName || 'agy.exe').toLowerCase();
const credentialWriterScript = payload.credentialWriterScript || null;
const ownPid = process.pid;

log('Worker started. Own PID: ' + ownPid);
log('DB Path: ' + dbPath);
log('Product: ' + productName);
log('Process name: ' + processName);
log('Executable: ' + executablePath);
log('ELECTRON_RUN_AS_NODE: ' + process.env.ELECTRON_RUN_AS_NODE);

// Find processes belonging to the selected product, including names with spaces.
function getOtherAntigravityPids() {
  try {
    const safeProcessName = String(processName || '').replace(/"/g, '');
    if (!safeProcessName) return [];
    const out = execSync('tasklist /FI "IMAGENAME eq ' + safeProcessName + '" /FO CSV /NH', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = [];
    for (const line of out.split('\\n')) {
      const match = line.match(/^"([^"]+)","(\\d+)"/);
      if (match && match[1].toLowerCase() === safeProcessName.toLowerCase()) {
        const pid = parseInt(match[2], 10);
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

// ── PowerShell helper (script passed as -EncodedCommand → no quoting issues) ──
function runPowerShell(script, extraEnv) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execSync('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + encoded, {
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, extraEnv || {}),
    timeout: 60000,
  });
}

// ── Agent hub (agy.exe --hub) process discovery ──
function listAgyProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    const safeName = agyProcessName.replace(/'/g, '');
    const out = runPowerShell(
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '" + safeName + "' } | " +
      'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
    );
    const text = String(out || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({
      pid: Number(p.ProcessId),
      ppid: Number(p.ParentProcessId),
      cmd: String(p.CommandLine || ''),
    }));
  } catch (e) {
    log('Could not list agent hub processes: ' + String(e));
    return [];
  }
}

// Stops any running agy.exe --hub daemon processes after the IDE has exited.
// Relying only on ParentProcessId is unsafe because once the parent IDE utility
// process exits, orphaned hub processes may retain a dead PPID while still
// holding the old OAuth token in memory.
function stopAllAgyHubProcesses() {
  const hubs = listAgyProcesses().filter(p => p.pid !== ownPid && (!p.cmd || p.cmd.indexOf('--hub') !== -1));
  if (hubs.length) {
    log('Stopping lingering agy.exe --hub processes: ' + hubs.map(h => h.pid).join(', '));
    for (const h of hubs) {
      try {
        execSync('taskkill /F /PID ' + h.pid, { stdio: 'ignore', windowsHide: true });
        log('  Stopped agent hub PID ' + h.pid);
      } catch (e) {
        log('  Failed to stop agent hub PID ' + h.pid + ': ' + String(e));
      }
    }
    return;
  }
  // Fallback if CIM query returned nothing or failed: kill by image name directly
  try {
    execSync('taskkill /F /IM "' + agyProcessName + '"', { stdio: 'ignore', windowsHide: true });
    log('Stopped ' + agyProcessName + ' processes via taskkill /IM fallback.');
  } catch {
    log('No lingering agy.exe processes found.');
  }
}

// ── Built-in extension state (google.google-antigravity) ──
// Keeps the agent UI onboarding info ("last login username") in sync with the
// injected account. Preserves all existing keys inside google.google-antigravity.
function patchExtensionState(db) {
  if (!extensionStatePatch || !extensionStatePatch.key) return;
  try {
    const st = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
    st.bind([extensionStatePatch.key]);
    const exists = st.step();
    const raw = exists ? st.get()[0] : null;
    st.free();
    let obj = {};
    if (exists && raw !== null && raw !== undefined) {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8');
      try { obj = JSON.parse(text); } catch { obj = {}; }
      if (!obj || typeof obj !== 'object') obj = {};
    }
    const rootKey = extensionStatePatch.storageRoot;
    const storage = (obj[rootKey] && typeof obj[rootKey] === 'object') ? obj[rootKey] : {};
    const values = extensionStatePatch.values || {};
    for (const k of Object.keys(values)) storage[k] = values[k];
    obj[rootKey] = storage;
    db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [extensionStatePatch.key, JSON.stringify(obj)]);
    log('  PATCHED: ' + extensionStatePatch.key + ' (onboarding login info)');
  } catch (e) {
    log('  WARNING: Failed to patch extension state: ' + String(e));
  }
}

// ── Agent hub credential (Windows Credential Manager "gemini:antigravity") ──
function writeAgyCredential() {
  if (!agyCredential || !credentialWriterScript) {
    log('No agent hub credential to write.');
    return;
  }
  if (process.platform !== 'win32') {
    log('Agent hub credential write is only supported on Windows.');
    return;
  }
  const credFile = path.join(path.dirname(payloadPath), '.agy-cred-' + process.pid + '.json');
  try {
    fs.writeFileSync(credFile, JSON.stringify(agyCredential), 'utf-8');
    const out = runPowerShell(credentialWriterScript, { AGY_CRED_FILE: credFile });
    if (String(out).indexOf('AGY_CREDENTIAL_WRITTEN') !== -1) {
      log('Agent hub credential updated (' + agyCredential.target + ').');
    } else {
      log('WARNING: Credential writer finished without confirmation.');
    }
  } catch (e) {
    log('WARNING: Failed to write agent hub credential: ' + String((e && e.message) || e));
  } finally {
    try { fs.unlinkSync(credFile); } catch {}
  }
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

  // Phase 2b: Stop any lingering agy.exe --hub backend processes so they
  // cannot overwrite the new keyring credential with a cached token.
  stopAllAgyHubProcesses();

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
    const schema = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'");
    if (!schema.length || !schema[0].values.length) {
      throw new Error('ItemTable was not found in the selected state database.');
    }
    for (const { key, value } of rows) {
      if (value === null) {
        db.run('DELETE FROM ItemTable WHERE key = ?', [key]);
        log('  DELETED: ' + key);
      } else {
        db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [key, value]);
        log('  INJECTED: ' + key + ' (' + value.length + ' chars)');
      }
    }
    patchExtensionState(db);
    const out = db.export();
    fs.writeFileSync(dbPath, Buffer.from(out));
    log('Database saved.');
  } finally {
    db.close();
  }

  const verificationDb = new SQL.Database(fs.readFileSync(dbPath));
  try {
    for (const { key, value } of rows) {
      const statement = verificationDb.prepare('SELECT value FROM ItemTable WHERE key = ?');
      statement.bind([key]);
      const exists = statement.step();
      const actual = exists ? statement.get()[0] : undefined;
      statement.free();
      if (value === null ? exists : actual !== value) {
        throw new Error('Post-write verification failed for key: ' + key);
      }
    }
    log('Post-write verification succeeded for ' + rows.length + ' keys.');
  } finally {
    verificationDb.close();
  }

  // Cleanup payload file
  try { fs.unlinkSync(payloadPath); } catch {}

  // ── Update the agent hub credential (Windows Credential Manager) ──
  writeAgyCredential();

  // ── Relaunch Antigravity ──
  const relaunchExe = executablePath && fs.existsSync(executablePath) ? executablePath : null;
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
        // 1. Prefer the new built-in extension state (google.google-antigravity),
        //    which stores the active account under antigravity-storage["agy.onboarding.lastLoginUsername"].
        const extEmail = this.readEmailFromExtensionState(db);
        if (extEmail) {
          Logger.getInstance().info(`Detected active Antigravity account (extension state): ${extEmail}`);
          return extEmail;
        }

        // 2. Fallback: read the legacy userStatus entry which contains the email
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
          Logger.getInstance().info(`Detected active Antigravity account (userStatus): ${email}`);
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
   * Reads the active email from the built-in `google.google-antigravity`
   * extension state JSON (`antigravity-storage["agy.onboarding.lastLoginUsername"]`).
   */
  private readEmailFromExtensionState(db: any): string | null {
    try {
      const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = $key');
      stmt.bind({ $key: STATE_DB_KEYS.EXTENSION_STATE });
      if (!stmt.step()) {
        stmt.free();
        return null;
      }
      const row = stmt.get();
      stmt.free();
      const raw = row[0];
      if (!raw) return null;
      const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8');
      const parsed = JSON.parse(text);
      const storage = parsed?.[EXTENSION_STATE_KEYS.STORAGE_ROOT];
      const email = storage?.[EXTENSION_STATE_KEYS.LAST_LOGIN_USERNAME];
      if (typeof email === 'string' && email.includes('@')) {
        return email.trim();
      }
      return null;
    } catch (e) {
      Logger.getInstance().warn('Failed to parse google.google-antigravity extension state', e);
      return null;
    }
  }

  /**
   * Extracts the email from a base64-encoded userStatus protobuf.
   * The structure is: Topic → DataEntry → Row → UserStatus payload.
   * In full UserStatus messages written by Antigravity, field 3 is the display
   * name and field 7 is the email; in minimal injected payloads both contain the email.
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

      // Level 6: Extract email from UserStatus (prefer field 7 which is always the email,
      // then fall back to field 3 only if it looks like an email address)
      const emailField7 = this.extractStringField(userStatusBytes, 7);
      if (emailField7 && emailField7.includes('@')) {
        return emailField7.trim();
      }
      const emailField3 = this.extractStringField(userStatusBytes, 3);
      if (emailField3 && emailField3.includes('@')) {
        return emailField3.trim();
      }
      
      return emailField7 || emailField3 || null;
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

  private validateTargetPath(dataPath: string, dbPath: string): void {
    const dataRoot = path.resolve(dataPath).toLowerCase() + path.sep;
    const database = path.resolve(dbPath).toLowerCase();
    if (!database.startsWith(dataRoot)) {
      throw new Error('The state database does not belong to the detected Antigravity product.');
    }
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

  /**
   * Builds the keyring credential consumed by the agent hub (agy.exe).
   * The JSON mirrors exactly what agy writes itself:
   *   { token: { access_token, token_type, refresh_token, expiry, expires_in },
   *     auth_method: "consumer", id_token_email, writer_id }
   *
   * Only personal (consumer) accounts are supported for now: the auth_method
   * value used by agy for GCP/enterprise logins is unknown, and writing a wrong
   * one would break the agent login.
   */
  private buildAgyCredential(
    email: string,
    tokens: AccountTokens,
    isGcpTos: boolean
  ): AgyCredentialPayload | null {
    if (process.platform !== 'win32') {
      Logger.getInstance().info('Agent hub keyring sync skipped (non-Windows platform).');
      return null;
    }
    if (isGcpTos) {
      Logger.getInstance().warn(`Agent hub keyring sync skipped for non-consumer account ${email}.`);
      return null;
    }
    if (!tokens.accessToken || !tokens.refreshToken) {
      Logger.getInstance().warn(`Agent hub keyring sync skipped for ${email}: missing tokens.`);
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = Number(tokens.expiresAt) || nowSeconds;
    const value = JSON.stringify({
      token: {
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        refresh_token: tokens.refreshToken,
        expiry: new Date(expiresAt * 1000).toISOString(),
        expires_in: Math.max(0, expiresAt - nowSeconds),
      },
      auth_method: AGY_CREDENTIAL.AUTH_METHOD_CONSUMER,
      id_token_email: email,
      writer_id: randomBytes(16).toString('base64url'),
    });

    return { target: AGY_CREDENTIAL.TARGET, userName: AGY_CREDENTIAL.USER_NAME, value };
  }

  // ─── Live injection (no window reload) ────────────────────────────────────
  //
  // Instead of closing the window, spawning a worker, patching state.vscdb on
  // disk, and relaunching the IDE, this path writes credentials directly while
  // the IDE is running and then asks VS Code to restart only the extension host.
  //
  // Why this works with the new Antigravity architecture (v1.107.0+):
  //   - The AI agent runs in agy.exe --hub which reads its OAuth token from the
  //     OS Credential Manager ("gemini:antigravity"), NOT from state.vscdb.
  //   - "Restart Extension Host" kills the old extension host process (which
  //     owns the agy.exe --hub child), then spins up a fresh one. The restarted
  //     google.google-antigravity extension spawns a new hub that reads the
  //     updated credential.
  //   - The main Electron process (UI) stays alive, so open tabs, terminals,
  //     and unsaved work are preserved.
  //

  async injectAccountStateLive(
    account: Account,
    tokens: AccountTokens,
    deviceProfile?: DeviceProfile | null
  ): Promise<'success' | 'cancelled' | 'error'> {
    const product = PathUtils.getAntigravityProduct();
    const versionCheckResult = this.checkAntigravityVersion();
    if (versionCheckResult === 'unsupported') {
      const i18n = I18nService.getInstance();
      vscode.window.showErrorMessage(
        i18n.t('stateDb.outdatedAntigravity', { minVersion: MIN_SUPPORTED_VERSION }),
        { modal: true }
      );
      return 'error';
    }

    try {
      const isGcpTos = this.shouldEnableGcpTos(account.email);

      // ── Step 1: Write keyring credential ──
      const agyCredential = this.buildAgyCredential(account.email, tokens, isGcpTos);
      if (agyCredential) {
        await this.writeCredentialDirect(agyCredential);
      }

      // ── Step 2: Kill existing agy.exe --hub processes ──
      await this.killAgyHubProcesses();

      // ── Step 3: Small delay to let processes terminate ──
      await new Promise(resolve => setTimeout(resolve, 500));

      // ── Step 4: Restart Extension Host ──
      Logger.getInstance().info('Restarting extension host for live account switch...');
      await vscode.commands.executeCommand('workbench.action.restartExtensionHost');

      return 'success';
    } catch (error: any) {
      Logger.getInstance().error('Live account injection failed', error);
      // Fallback: try the legacy worker-based approach
      Logger.getInstance().info('Falling back to legacy worker-based injection...');
      return this.injectAccountState(account, tokens, deviceProfile);
    }
  }

  /**
   * Writes a credential directly to Windows Credential Manager from within
   * the extension host process (no external worker needed).
   */
  private async writeCredentialDirect(credential: AgyCredentialPayload): Promise<void> {
    if (process.platform !== 'win32') {
      Logger.getInstance().info('Credential write skipped (non-Windows).');
      return;
    }

    const credFile = path.join(__dirname, `.agy-cred-live-${process.pid}.json`);
    try {
      fs.writeFileSync(credFile, JSON.stringify(credential), 'utf-8');

      const workerEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGY_CRED_FILE: credFile };
      const encoded = Buffer.from(AGY_CREDENTIAL_WRITER_PS, 'utf16le').toString('base64');
      const { execSync } = require('child_process');
      const result = execSync(
        'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + encoded,
        {
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: workerEnv,
          timeout: 30000,
        }
      );

      if (String(result).includes('AGY_CREDENTIAL_WRITTEN')) {
        Logger.getInstance().info(`Credential updated for ${credential.target}.`);
      } else {
        Logger.getInstance().warn('Credential writer finished without confirmation.');
      }
    } finally {
      try { fs.unlinkSync(credFile); } catch { /* ignore */ }
    }
  }

  /**
   * Kills all running agy.exe --hub processes so they don't cache old tokens.
   */
  private async killAgyHubProcesses(): Promise<void> {
    if (process.platform !== 'win32') return;

    try {
      const { execSync } = require('child_process');
      const processName = AGY_CREDENTIAL.PROCESS_NAME;

      // Try via tasklist first
      try {
        const out = execSync(`tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        const pids: number[] = [];
        for (const line of out.split('\n')) {
          const match = line.match(/^"([^"]+)","(\d+)"/);
          if (match && match[1].toLowerCase() === processName.toLowerCase()) {
            pids.push(parseInt(match[2], 10));
          }
        }
        if (pids.length > 0) {
          Logger.getInstance().info(`Killing ${pids.length} agy.exe processes: ${pids.join(', ')}`);
          for (const pid of pids) {
            try {
              execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true });
            } catch { /* best effort */ }
          }
        }
      } catch {
        // Fallback: kill by image name
        try {
          execSync(`taskkill /F /IM "${processName}"`, { stdio: 'ignore', windowsHide: true });
        } catch { /* no processes found, fine */ }
      }
    } catch (e) {
      Logger.getInstance().warn('Failed to kill agy.exe processes: ' + String(e));
    }
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
