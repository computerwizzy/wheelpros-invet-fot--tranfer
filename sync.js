/**
 * sync.js
 * ───────────────────────────────────────────────────────────────────
 * WheelPros SFTP  →  WheelsbelowRetail FTP  inventory feed sync
 * Handles 2 files: TIRES and WHEELS (separate directories each)
 * Skips upload if file has NOT changed since last sync.
 *
 * Usage:
 *   node sync.js          — starts the cron scheduler (keeps running)
 *   node sync.js --once   — runs a single sync and exits
 *   node sync.js --force  — forces sync even if files haven't changed
 * ───────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const SftpClient = require('ssh2-sftp-client');
const ftp        = require('basic-ftp');

// ─── Validate required env vars before doing anything ──────────────
const REQUIRED = [
  'SFTP_HOST','SFTP_USER','SFTP_PASS',
  'SFTP_TIRES_PATH','SFTP_WHEELS_PATH',
  'FTP_HOST','FTP_USER','FTP_PASS',
  'FTP_TIRES_DIR','FTP_WHEELS_DIR',
];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('❌ Missing required environment variables:');
  missing.forEach(k => console.error(`   - ${k}`));
  console.error('\nAdd these as GitHub Secrets or in your .env file.');
  process.exit(1);
}
const cron       = require('node-cron');
const fs         = require('fs');
const path       = require('path');

// ─── Config from .env ──────────────────────────────────────────────
const SFTP_CONFIG = {
  host:         process.env.SFTP_HOST,
  port:         parseInt(process.env.SFTP_PORT || '22'),
  username:     process.env.SFTP_USER,
  password:     process.env.SFTP_PASS,
  tryKeyboard:  true,
  readyTimeout: 20000,
  hostVerifier: (hashedKey) => {
    const knownFingerprint = process.env.SFTP_FINGERPRINT;
    if (!knownFingerprint) return true;
    const b64 = hashedKey.toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const match = knownFingerprint.includes(b64);
    if (!match) {
      log(`[SFTP] ❌ Host fingerprint mismatch! Expected: ${knownFingerprint}, Got: ...${b64.slice(-20)}`);
    }
    return match;
  },
};

const FTP_CONFIG = {
  host:     process.env.FTP_HOST,
  port:     parseInt(process.env.FTP_PORT || '21'),
  user:     process.env.FTP_USER,
  password: process.env.FTP_PASS,
  secure:   process.env.FTP_SECURE !== 'false',
  secureOptions: {
    rejectUnauthorized: process.env.FTP_REJECT_UNAUTHORIZED !== 'false'
  }
};

const SYNC_JOBS = [
  {
    label:    'TIRES',
    sftpPath: process.env.SFTP_TIRES_PATH,
    ftpDir:   process.env.FTP_TIRES_DIR,
  },
  {
    label:    'WHEELS',
    sftpPath: process.env.SFTP_WHEELS_PATH,
    ftpDir:   process.env.FTP_WHEELS_DIR,
  },
];

const CRON_SCHEDULE  = process.env.CRON_SCHEDULE || '0 */4 * * *';
const TMP_DIR        = path.join(__dirname, 'tmp');
const STATE_FILE     = path.join(__dirname, 'last-sync.json');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// ─── Logging ───────────────────────────────────────────────────────
function log(msg) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(__dirname, 'sync.log'), line + '\n');
}

// ─── State: track last synced modification times ───────────────────
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Step 1: Check + Download changed files from SFTP ──────────────
async function downloadChangedFiles(jobs, force = false) {
  const sftp  = new SftpClient();
  const state = loadState();
  let   anyChanged = false;

  try {
    log(`[SFTP] Connecting to ${SFTP_CONFIG.host}:${SFTP_CONFIG.port}...`);
    await sftp.connect(SFTP_CONFIG);
    log('[SFTP] ✅ Connected.');

    for (const job of jobs) {
      log(`[SFTP][${job.label}] Checking modification time: ${job.sftpPath}`);

      const stat    = await sftp.stat(job.sftpPath);
      const remoteModified = stat.modifyTime; // ms timestamp
      const lastSynced     = state[job.label]?.modifyTime || 0;

      if (!force && remoteModified <= lastSynced) {
        log(`[SFTP][${job.label}] ⏭  No change detected (last synced: ${new Date(lastSynced).toISOString()}). Skipping.`);
        job.skip = true;
        continue;
      }

      log(`[SFTP][${job.label}] 🆕 File is newer — downloading...`);
      const localFile  = path.join(TMP_DIR, path.basename(job.sftpPath));
      job.localFile    = localFile;
      job.modifyTime   = remoteModified;
      job.skip         = false;

      await sftp.fastGet(job.sftpPath, localFile);
      const size = fs.statSync(localFile).size;
      log(`[SFTP][${job.label}] ✅ Downloaded — ${(size / 1024).toFixed(1)} KB`);
      anyChanged = true;
    }
  } finally {
    await sftp.end();
    log('[SFTP] Connection closed.');
  }

  return anyChanged;
}

// ─── Step 2: Upload changed files to FTP ───────────────────────────
async function uploadChangedFiles(jobs) {
  const toUpload = jobs.filter(j => !j.skip && j.localFile);
  if (toUpload.length === 0) {
    log('[FTP] Nothing to upload — all files are current.');
    return;
  }

  const client = new ftp.Client();
  client.ftp.verbose = false;
  const state = loadState();

  try {
    log(`[FTP] Connecting to ${FTP_CONFIG.host}:${FTP_CONFIG.port} (secure: ${FTP_CONFIG.secure})...`);
    try {
      await client.access(FTP_CONFIG);
      log(`[FTP] ✅ Connected (${FTP_CONFIG.secure ? 'FTPS' : 'plain'}).`);
    } catch (e) {
      if (FTP_CONFIG.secure) {
        log(`[FTP] FTPS connection failed: ${e.message}. Trying plain FTP...`);
        client.close();
        await client.access({
          ...FTP_CONFIG,
          secure: false
        });
        log('[FTP] ✅ Connected (plain fallback).');
      } else {
        throw e;
      }
    }

    for (const job of toUpload) {
      const remoteName = path.basename(job.localFile);
      log(`[FTP][${job.label}] Navigating to: ${job.ftpDir}`);
      await client.ensureDir(job.ftpDir);

      log(`[FTP][${job.label}] Uploading: ${remoteName}`);
      await client.uploadFrom(job.localFile, remoteName);
      log(`[FTP][${job.label}] ✅ Uploaded → ${job.ftpDir}/${remoteName}`);

      // Save the synced modifyTime so next run can compare
      state[job.label] = { modifyTime: job.modifyTime, syncedAt: new Date().toISOString() };
      saveState(state);
    }
  } finally {
    client.close();
    log('[FTP] Connection closed.');
  }
}

// ─── Cleanup temp files ────────────────────────────────────────────
function cleanup(jobs) {
  for (const job of jobs) {
    if (job.localFile && fs.existsSync(job.localFile)) {
      fs.unlinkSync(job.localFile);
      log(`[CLEANUP][${job.label}] Temp file removed.`);
    }
  }
}

// ─── Full sync job ─────────────────────────────────────────────────
async function runSync(force = false) {
  log('═══════════════════════════════════════════════════════');
  log(`🔄  WheelPros SFTP → WheelsbelowRetail FTP sync${force ? ' (FORCED)' : ''}`);
  log(`    Files: ${SYNC_JOBS.map(j => j.label).join(', ')}`);
  log('═══════════════════════════════════════════════════════');

  // Reset job state for this run
  SYNC_JOBS.forEach(j => { j.skip = false; j.localFile = null; j.modifyTime = null; });

  try {
    const anyChanged = await downloadChangedFiles(SYNC_JOBS, force);

    if (!anyChanged) {
      log('✅ All files are up to date — nothing to upload.');
    } else {
      await uploadChangedFiles(SYNC_JOBS);
    }

    cleanup(SYNC_JOBS);
    log('✅ Sync run complete.');
  } catch (err) {
    log(`❌ Sync FAILED: ${err.message}`);
    console.error(err);
    cleanup(SYNC_JOBS);
  }
}

// ─── Entry point ───────────────────────────────────────────────────
const runOnce = process.argv.includes('--once');
const force   = process.argv.includes('--force');

if (runOnce || force) {
  runSync(force).then(() => {
    log('Exiting.');
    process.exit(0);
  });
} else {
  if (!cron.validate(CRON_SCHEDULE)) {
    console.error(`❌ Invalid CRON_SCHEDULE: "${CRON_SCHEDULE}"`);
    process.exit(1);
  }

  log(`🕐 Scheduler started. Cron: "${CRON_SCHEDULE}"`);
  log('   Running first sync now...');

  runSync();
  cron.schedule(CRON_SCHEDULE, () => runSync());
}
