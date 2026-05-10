/**
 * Standalone injection worker — runs as a detached process AFTER
 * the Antigravity window has fully closed.
 *
 * Usage: node inject-worker.js <payloadJsonPath>
 *
 * 1. Waits for state.vscdb to stop being written to (Antigravity exited)
 * 2. Injects the payload
 * 3. Optionally relaunches Antigravity
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const payloadPath = process.argv[2];
if (!payloadPath || !fs.existsSync(payloadPath)) {
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf-8'));
const { dbPath, rows, antigravityExe } = payload;

async function waitForFileStable(filePath, stableMs = 2000, maxWaitMs = 15000) {
  const start = Date.now();
  let lastMtime = 0;
  while (Date.now() - start < maxWaitMs) {
    try {
      const stat = fs.statSync(filePath);
      const mtime = stat.mtimeMs;
      if (lastMtime > 0 && mtime === lastMtime) {
        // File hasn't changed for stableMs
        return true;
      }
      lastMtime = mtime;
    } catch (e) { /* file might be locked */ }
    await new Promise(r => setTimeout(r, stableMs));
  }
  return true; // proceed anyway after max wait
}

async function inject() {
  // Wait for Antigravity to finish writing
  await waitForFileStable(dbPath);

  // Use sql.js (bundled alongside)
  let initSqlJs;
  try {
    initSqlJs = require('sql.js');
  } catch (e) {
    // Try from the extension's node_modules
    const extRoot = path.resolve(__dirname, '..', '..', '..');
    initSqlJs = require(path.join(extRoot, 'node_modules', 'sql.js'));
  }

  const SQL = await initSqlJs();
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  try {
    for (const { key, value } of rows) {
      if (value === null) {
        db.run('DELETE FROM ItemTable WHERE key = ?', [key]);
      } else {
        db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [key, value]);
      }
    }
    const out = db.export();
    fs.writeFileSync(dbPath, Buffer.from(out));
  } finally {
    db.close();
  }

  // Clean up payload file
  try { fs.unlinkSync(payloadPath); } catch (e) {}

  // Relaunch Antigravity if exe path provided
  if (antigravityExe && fs.existsSync(antigravityExe)) {
    const { spawn } = require('child_process');
    spawn(antigravityExe, [], { detached: true, stdio: 'ignore' }).unref();
  }
}

inject().catch(() => process.exit(1));
