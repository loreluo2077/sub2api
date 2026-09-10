#!/usr/bin/env node
// Local development launcher for the Sub2API backend.
// Reads .env.local (plain text, cross-platform), sets process.env, then runs `go run ./cmd/server`.
//
// Usage:
//   node start.js                # normal start (skips setup if config.yaml/.installed exists)
//   node start.js --first-run    # first launch: AUTO_SETUP=true + generate admin password / secrets
//   node start.js --verbose      # print environment (without secret values)

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = __dirname;
const ENV_FILE = path.join(BACKEND_DIR, '.env.local');

// ---------------------------------------------------------------------------
// .env parsing (simple: KEY=VALUE, # comments, no interpolation)
// ---------------------------------------------------------------------------
function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

function saveEnv(file, env) {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  console.log(`[start] wrote ${file}`);
}

const isFirstRun = process.argv.includes('--first-run');
const isVerbose = process.argv.includes('--verbose');

const existing = loadEnv(ENV_FILE);
const env = { ...existing };

// First run: fill in missing secrets and a random admin password.
if (isFirstRun) {
  if (!env.JWT_SECRET) env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  if (!env.TOTP_ENCRYPTION_KEY) env.TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  if (!env.ADMIN_PASSWORD) {
    // Strong, copy-paste friendly (no ambiguous lookalikes).
    env.ADMIN_PASSWORD = crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  }
  saveEnv(ENV_FILE, env);
  console.log('');
  console.log('==================================================');
  console.log('  ADMIN_EMAIL    :', env.ADMIN_EMAIL || 'admin@sub2api.local');
  console.log('  ADMIN_PASSWORD :', env.ADMIN_PASSWORD);
  console.log('  JWT_SECRET     :', env.JWT_SECRET);
  console.log('  TOTP_ENCRYPTION_KEY:', env.TOTP_ENCRYPTION_KEY);
  console.log('  >> Save these now. The password is shown only this once.');
  console.log('==================================================');
  console.log('');
}

// Apply everything to process.env for the child process.
for (const [k, v] of Object.entries(env)) process.env[k] = v;

if (isFirstRun) {
  if (!env.AUTO_SETUP) env.AUTO_SETUP = 'true';
  process.env.AUTO_SETUP = env.AUTO_SETUP;
  if (!process.env.ADMIN_EMAIL) {
    const email = env.ADMIN_EMAIL || 'admin@sub2api.local';
    process.env.ADMIN_EMAIL = email;
  }
}

if (isVerbose) {
  const safe = { ...env };
  for (const k of Object.keys(safe)) {
    if (/PASSWORD|SECRET|KEY/i.test(k)) safe[k] = '***';
  }
  console.log('[start] env:', JSON.stringify(safe, null, 2));
}

console.log('[start] go run ./cmd/server ...');
const child = spawn('go', ['run', './cmd/server'], {
  cwd: BACKEND_DIR,
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => {
  console.log(`[start] backend exited with code ${code}`);
  process.exit(code == null ? 0 : code);
});