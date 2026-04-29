/**
 * sync.js
 * ───────────────────────────────────────────────────────────────────
 * WheelPros SFTP  →  WheelsbelowRetail FTP  inventory feed sync
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

const SFTP_REMOTE_PATH = process.env.SFTP_REMOTE_PATH;

const FTP_CONFIG = {
  host:     process.env.FTP_HOST,
  port:     parseInt(process.env.FTP_PORT || '21'),
  user:     process.env.FTP_USER,
  password: process.env.FTP_PASS,
};

const FTP_REMOTE_DIR  = process.env.FTP_REMOTE_DIR  || '/';
const CRON_SCHEDULE   = process.env.CRON_SCHEDULE   || '0 * * * *';

// ─── Temp local file ───────────────────────────────────────────────
const TMP_DIR       = path.join(__dirname, 'tmp');
const LOCAL_FILE    = path.join(TMP_DIR, path.basename(SFTP_REMOTE_PATH || 'feed.csv'));

// ─── Logging helper ────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(__dirname, 'sync.log'), line + '\n');
}

// ─── Ensure tmp dir exists ─────────────────────────────────────────
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// ─── Step 1: Download from SFTP ────────────────────────────────────
async function downloadFromSftp() {
  const sftp = new SftpClient();
  try {
    log(`[SFTP] Connecting to ${SFTP_CONFIG.host}:${SFTP_CONFIG.port} as ${SFTP_CONFIG.username}...`);
    await sftp.connect(SFTP_CONFIG);

    log(`[SFTP] Downloading: ${SFTP_REMOTE_PATH} → ${LOCAL_FILE}`);
    await sftp.fastGet(SFTP_REMOTE_PATH, LOCAL_FILE);

    const stats = fs.statSync(LOCAL_FILE);
    log(`[SFTP] ✅ Download complete. File size: ${(stats.size / 1024).toFixed(1)} KB`);
  } finally {
    await sftp.end();
    log('[SFTP] Connection closed.');
  }
}

// ─── Step 2: Upload to FTP ─────────────────────────────────────────
async function uploadToFtp() {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    log(`[FTP] Connecting to ${FTP_CONFIG.host}:${FTP_CONFIG.port} as ${FTP_CONFIG.user}...`);
    await client.access(FTP_CONFIG);

    log(`[FTP] Navigating to directory: ${FTP_REMOTE_DIR}`);
    await client.ensureDir(FTP_REMOTE_DIR);

    const remoteName = path.basename(LOCAL_FILE);
    log(`[FTP] Uploading: ${LOCAL_FILE} → ${FTP_REMOTE_DIR}/${remoteName}`);
    await client.uploadFrom(LOCAL_FILE, remoteName);

    log(`[FTP] ✅ Upload complete: ${FTP_REMOTE_DIR}/${remoteName}`);
  } finally {
    client.close();
    log('[FTP] Connection closed.');
  }
}

// ─── Cleanup temp file ─────────────────────────────────────────────
function cleanup() {
  if (fs.existsSync(LOCAL_FILE)) {
    fs.unlinkSync(LOCAL_FILE);
    log('[CLEANUP] Temp file removed.');
  }
}

// ─── Full sync job ─────────────────────────────────────────────────
async function runSync() {
  log('═══════════════════════════════════════════');
  log('🔄 Starting WheelPros SFTP → FTP sync...');
  log('═══════════════════════════════════════════');

  try {
    await downloadFromSftp();
    await uploadToFtp();
    cleanup();
    log('✅ Sync completed successfully.');
  } catch (err) {
    log(`❌ Sync FAILED: ${err.message}`);
    console.error(err);
    cleanup();
  }
}

// ─── Entry point ───────────────────────────────────────────────────
const runOnce = process.argv.includes('--once');

if (runOnce) {
  // Single run then exit
  runSync().then(() => {
    log('Single-run mode: exiting.');
    process.exit(0);
  });
} else {
  // Validate cron expression
  if (!cron.validate(CRON_SCHEDULE)) {
    console.error(`❌ Invalid CRON_SCHEDULE: "${CRON_SCHEDULE}"`);
    process.exit(1);
  }

  log(`🕐 Scheduler started. Cron: "${CRON_SCHEDULE}"`);
  log('   Running first sync now...');

  // Run immediately on start, then follow the schedule
  runSync();

  cron.schedule(CRON_SCHEDULE, () => {
    runSync();
  });
}
