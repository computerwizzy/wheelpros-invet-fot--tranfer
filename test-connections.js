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
  console.log('\n─── SFTP Connection Test (sftp.wheelpros.com) ─────────────');

  try {
    console.log(`Host : ${process.env.SFTP_HOST}:${process.env.SFTP_PORT || 22}`);
    console.log(`User : ${process.env.SFTP_USER}`);

    const knownFingerprint = process.env.SFTP_FINGERPRINT || null;

    await sftp.connect({
      host:         process.env.SFTP_HOST,
      port:         parseInt(process.env.SFTP_PORT || '22'),
      username:     process.env.SFTP_USER,
      password:     process.env.SFTP_PASS,
      tryKeyboard:  true,
      readyTimeout: 20000,
      retries:      2,
      // Accept the server's host key if fingerprint matches (or bypass if none set)
      hostVerifier: (hashedKey) => {
        if (!knownFingerprint) return true;
        // hashedKey is a Buffer — convert to base64 for comparison
        const b64 = hashedKey.toString('base64')
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const match = knownFingerprint.includes(b64);
        if (!match) {
          console.log(`   ⚠️  Host fingerprint mismatch!`);
          console.log(`   Expected: ${knownFingerprint}`);
          console.log(`   Got:      ...${b64.slice(-20)}`);
        }
        return true; // still allow — just warn on mismatch
      },
    });

    console.log('✅ SFTP connected!\n');

    // Check both files
    const files = [
      { label: 'TIRES',  remotePath: process.env.SFTP_TIRES_PATH },
      { label: 'WHEELS', remotePath: process.env.SFTP_WHEELS_PATH },
    ];

    for (const f of files) {
      const dir = f.remotePath.substring(0, f.remotePath.lastIndexOf('/')) || '/';
      console.log(`── [${f.label}] Path: ${f.remotePath}`);

      // List parent directory
      try {
        const list = await sftp.list(dir);
        console.log(`   Directory listing (${dir}):`);
        list.forEach(item => {
          const size = item.type === '-' ? ` (${(item.size / 1024).toFixed(1)} KB)` : '';
          console.log(`     ${item.type === 'd' ? '📁' : '📄'} ${item.name}${size}`);
        });
      } catch (e) {
        console.log(`   ⚠️  Could not list directory: ${e.message}`);
      }

      // Check if target file exists
      const exists = await sftp.exists(f.remotePath);
      console.log(`   File exists: ${exists ? '✅ YES' : '❌ NOT FOUND'}\n`);
    }

  } catch (err) {
    console.error(`❌ SFTP FAILED: ${err.message}`);
  } finally {
    await sftp.end();
    console.log('[SFTP] Connection closed.');
  }
}

async function testFtp() {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  console.log('\n─── FTP Connection Test (ftp.wheelsbelowretail.com) ───────');

  try {
    console.log(`Host : ${process.env.FTP_HOST}:${process.env.FTP_PORT || 21}`);
    console.log(`User : ${process.env.FTP_USER}`);

    // Try FTPS first by default
    let connected = false;
    const useSecure = process.env.FTP_SECURE !== 'false';

    if (useSecure) {
      try {
        console.log('   Trying explicit TLS (FTPS)...');
        await client.access({
          host:                process.env.FTP_HOST,
          port:                parseInt(process.env.FTP_PORT || '21'),
          user:                process.env.FTP_USER,
          password:            process.env.FTP_PASS,
          secure:              true,
          secureOptions:       {
            rejectUnauthorized: process.env.FTP_REJECT_UNAUTHORIZED !== 'false'
          },
        });
        connected = true;
        console.log('✅ FTP connected (explicit TLS/FTPS)!\n');
      } catch (e) {
        console.log(`   Explicit TLS failed: ${e.message}`);
      }
    }

    if (!connected) {
      try {
        console.log('   Trying plain FTP...');
        client.close();
        await client.access({
          host:     process.env.FTP_HOST,
          port:     parseInt(process.env.FTP_PORT || '21'),
          user:     process.env.FTP_USER,
          password: process.env.FTP_PASS,
          secure:   false,
        });
        connected = true;
        console.log('✅ FTP connected (plain)!\n');
      } catch (e) {
        console.log(`   Plain FTP failed: ${e.message}`);
        throw new Error('Both plain FTP and FTPS failed (or FTPS failed and plain not attempted/failed).');
      }
    }

    // Check both destination directories
    const dirs = [
      { label: 'TIRES',  dir: process.env.FTP_TIRES_DIR },
      { label: 'WHEELS', dir: process.env.FTP_WHEELS_DIR },
    ];

    for (const d of dirs) {
      console.log(`── [${d.label}] Directory: ${d.dir}`);
      try {
        const list = await client.list(d.dir);
        if (list.length === 0) {
          console.log('   (empty directory)');
        } else {
          list.slice(0, 10).forEach(f => {
            const size = f.type === ftp.FileType.File ? ` (${(f.size / 1024).toFixed(1)} KB)` : '';
            console.log(`   ${f.type === ftp.FileType.Directory ? '📁' : '📄'} ${f.name}${size}`);
          });
          if (list.length > 10) console.log(`   ... and ${list.length - 10} more`);
        }
      } catch (e) {
        console.log(`   ⚠️  Could not list directory: ${e.message}`);
      }
      console.log();
    }

  } catch (err) {
    console.error(`❌ FTP FAILED: ${err.message}`);
  } finally {
    client.close();
    console.log('[FTP] Connection closed.');
  }
}

// ─── Run based on arg ──────────────────────────────────────────────
const arg = process.argv[2];

(async () => {
  if (!arg || arg === 'sftp') await testSftp();
  if (!arg || arg === 'ftp')  await testFtp();
  console.log('\n─── Done ───────────────────────────────────────────────────\n');
})();
