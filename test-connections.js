/**
 * test-connections.js
 * ─────────────────────────────────────────────────────────────────
 * Test SFTP or FTP connections independently before running full sync
 *
 * Usage:
 *   node test-connections.js sftp   — test WheelPros SFTP only
 *   node test-connections.js ftp    — test WheelsbelowRetail FTP only
 *   node test-connections.js        — test both
 */

require('dotenv').config();
const SftpClient = require('ssh2-sftp-client');
const ftp        = require('basic-ftp');

async function testSftp() {
  const sftp = new SftpClient();
  console.log('\n─── SFTP Connection Test ──────────────────────────────────');
  try {
    console.log(`Connecting to: ${process.env.SFTP_HOST}:${process.env.SFTP_PORT || 22}`);
    console.log(`User: ${process.env.SFTP_USER}`);

    await sftp.connect({
      host:     process.env.SFTP_HOST,
      port:     parseInt(process.env.SFTP_PORT || '22'),
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });

    console.log('✅ SFTP connected!');

    // List remote path directory
    const remotePath = process.env.SFTP_REMOTE_PATH;
    const dir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
    console.log(`\nListing directory: ${dir}`);
    const list = await sftp.list(dir);
    list.forEach(f => {
      const size = f.type === '-' ? ` (${(f.size / 1024).toFixed(1)} KB)` : '';
      console.log(`  ${f.type === 'd' ? '📁' : '📄'} ${f.name}${size}`);
    });

    // Check if target file exists
    const exists = await sftp.exists(remotePath);
    console.log(`\nTarget file "${remotePath}": ${exists ? '✅ Found' : '❌ NOT FOUND'}`);

  } catch (err) {
    console.error(`❌ SFTP FAILED: ${err.message}`);
  } finally {
    await sftp.end();
    console.log('Connection closed.');
  }
}

async function testFtp() {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  console.log('\n─── FTP Connection Test ───────────────────────────────────');
  try {
    console.log(`Connecting to: ${process.env.FTP_HOST}:${process.env.FTP_PORT || 21}`);
    console.log(`User: ${process.env.FTP_USER}`);

    await client.access({
      host:     process.env.FTP_HOST,
      port:     parseInt(process.env.FTP_PORT || '21'),
      user:     process.env.FTP_USER,
      password: process.env.FTP_PASS,
    });

    console.log('✅ FTP connected!');

    // List remote dir
    const remoteDir = process.env.FTP_REMOTE_DIR || '/';
    console.log(`\nListing directory: ${remoteDir}`);
    const list = await client.list(remoteDir);
    list.forEach(f => {
      const size = f.type === ftp.FileType.File ? ` (${(f.size / 1024).toFixed(1)} KB)` : '';
      console.log(`  ${f.type === ftp.FileType.Directory ? '📁' : '📄'} ${f.name}${size}`);
    });

  } catch (err) {
    console.error(`❌ FTP FAILED: ${err.message}`);
  } finally {
    client.close();
    console.log('Connection closed.');
  }
}

// ─── Run based on arg ──────────────────────────────────────────────
const arg = process.argv[2];

(async () => {
  if (!arg || arg === 'sftp') await testSftp();
  if (!arg || arg === 'ftp')  await testFtp();
})();
