/**
 * sync.js
 * ───────────────────────────────────────────────────────────────────
 * WheelPros SFTP  →  WheelsbelowRetail FTP  inventory feed sync
 * Handles 2 files: TIRES and WHEELS (separate directories each)
 *
 * Usage:
 *   node sync.js          — starts the cron scheduler (keeps running)
 *   node sync.js --once   — runs a single sync and exits
 * ───────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const SftpClient = require('ssh2-sftp-client');
const ftp        = require('basic-ftp');
const cron       = require('node-cron');
const fs         = require('fs');
const path       = require('path');

// ─── Config from .env ──────────────────────────────────────────────
const SFTP_CONFIG = {
  host:     process.env.SFTP_HOST,
  port:     parseInt(process.env.SFTP_PORT || '22'),
  username: process.env.SFTP_USER,
  password: process.env.SFTP_PASS,
};

const FTP_CONFIG = {
  host:     process.env.FTP_HOST,
  port:     parseInt(process.env.FTP_PORT || '21'),
  user:     process.env.FTP_USER,
  password: process.env.FTP_PASS,
};

// ─── File transfer jobs ────────────────────────────────────────────
// Each entry: { label, sftpPath, ftpDir }
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

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *';

// ─── Temp dir ──────────────────────────────────────────────────────
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// ─── Logging helper ────────────────────────────────────────────────
function log(msg) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(__dirname, 'sync.log'), line + '\n');
}

// ─── Step 1: Download all files from SFTP (single connection) ──────
async function downloadAllFromSftp(jobs) {
  const sftp = new SftpClient();
  try {
    log(`[SFTP] Connecting to ${SFTP_CONFIG.host}:${SFTP_CONFIG.port}...`);
    await sftp.connect(SFTP_CONFIG);
    log('[SFTP] ✅ Connected.');

    for (const job of jobs) {
      const localFile = path.join(TMP_DIR, path.basename(job.sftpPath));
      job.localFile   = localFile; // store for FTP upload step

      log(`[SFTP][${job.label}] Downloading: ${job.sftpPath}`);
      await sftp.fastGet(job.sftpPath, localFile);

      const size = fs.statSync(localFile).size;
      log(`[SFTP][${job.label}] ✅ Done — ${(size / 1024).toFixed(1)} KB`);
    }
  } finally {
    await sftp.end();
    log('[SFTP] Connection closed.');
  }
}

// ─── Step 2: Upload all files to FTP (single connection) ───────────
async function uploadAllToFtp(jobs) {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    log(`[FTP] Connecting to ${FTP_CONFIG.host}:${FTP_CONFIG.port}...`);
    await client.access(FTP_CONFIG);
    log('[FTP] ✅ Connected.');

    for (const job of jobs) {
      if (!job.localFile || !fs.existsSync(job.localFile)) {
        log(`[FTP][${job.label}] ⚠️  Skipping — local file not found.`);
        continue;
      }

      const remoteName = path.basename(job.localFile);
      log(`[FTP][${job.label}] Navigating to: ${job.ftpDir}`);
      await client.ensureDir(job.ftpDir);

      log(`[FTP][${job.label}] Uploading: ${remoteName}`);
      await client.uploadFrom(job.localFile, remoteName);
      log(`[FTP][${job.label}] ✅ Uploaded → ${job.ftpDir}/${remoteName}`);
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
async function runSync() {
  log('═══════════════════════════════════════════════════════');
  log('🔄  Starting WheelPros SFTP → WheelsbelowRetail FTP sync');
  log(`    Files: ${SYNC_JOBS.map(j => j.label).join(', ')}`);
  log('═══════════════════════════════════════════════════════');

  try {
    await downloadAllFromSftp(SYNC_JOBS);
    await uploadAllToFtp(SYNC_JOBS);
    cleanup(SYNC_JOBS);
    log('✅ All files synced successfully.');
  } catch (err) {
    log(`❌ Sync FAILED: ${err.message}`);
    console.error(err);
    cleanup(SYNC_JOBS);
  }
}

// ─── Entry point ───────────────────────────────────────────────────
const runOnce = process.argv.includes('--once');

if (runOnce) {
  runSync().then(() => {
    log('Single-run mode: exiting.');
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
