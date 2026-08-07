# products Inventory Feed Sync
**SFTP (sftp.yoursource.com) → FTP (ftp.yourftp.com) automated sync**

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure credentials
Edit `.env` and fill in all values:
```bash
# SFTP Source (WheelPros)
SFTP_HOST=sftp.wheelpros.com
SFTP_PORT=22
SFTP_USER=your_username
SFTP_PASS=your_password
SFTP_TIRES_PATH=/path/to/tires.csv
SFTP_WHEELS_PATH=/path/to/wheels.csv
SFTP_FINGERPRINT=optional_base64_fingerprint

# FTP Destination (WheelsbelowRetail)
FTP_HOST=ftp.yourdomain.com
FTP_PORT=21
FTP_USER=your_username
FTP_PASS=your_password
FTP_TIRES_DIR=/public_html/tires
FTP_WHEELS_DIR=/public_html/wheels
FTP_SECURE=false               # Set to true for FTPS
FTP_REJECT_UNAUTHORIZED=true   # Set to false to allow self-signed certificates

CRON_SCHEDULE=0 */4 * * *   # every 4 hours
```

### 3. Test connections before running
```bash
# Test SFTP only
npm run test-sftp

# Test FTP only
npm run test-ftp

# Test both
node test-connections.js
```

### 4. Run a single sync
```bash
npm run sync-once
```

### 5. Start the scheduled service
```bash
npm start
```

---

## Deployment — Railway (Recommended)

Railway gives you a free always-on Node.js process — perfect for this.

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add your `.env` variables in Railway's **Variables** tab
4. Deploy — Railway uses `railway.toml` to run `node sync.js` automatically

---

## File Structure
```
wheelpro-invenroty-feed/
├── .env                   ← credentials (never commit this!)
├── .gitignore
├── package.json
├── railway.toml           ← Railway deployment config
├── sync.js                ← main sync script
├── test-connections.js    ← test SFTP/FTP independently
├── tmp/                   ← temp download folder (auto-created)
└── sync.log               ← rolling log file (auto-created)
```

---

## Logs
- Logs are written to `sync.log` in the project root
- Each run shows timestamp, file size, and success/failure status

## Why not Cloudflare Workers?
SFTP runs over SSH (raw TCP), which Workers can't handle — they run in a V8 isolate
without native TCP socket support for the SSH protocol. Railway's Node.js environment
supports full TCP/SSH connections and is the correct runtime for this automation.
