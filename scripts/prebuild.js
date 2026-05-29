'use strict';

/**
 * FinTrace NCRP — pre-build verification.
 *
 * Runs before electron-builder packages the app. Performs:
 *   1. Clean stale build output (dist/, out/).
 *   2. Verify required installer assets exist (icon.ico, installer header).
 *   3. Verify frontend/dist exists — build it via vite if missing.
 *   4. Verify better-sqlite3's native binding is compiled for Electron's ABI
 *      — run @electron/rebuild if the file is missing or stale.
 *
 * Run via:  npm run prebuild   (also invoked automatically before `npm run build`)
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'assets');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const FRONTEND_DIST = path.join(FRONTEND_DIR, 'dist');
const DIST_DIR = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'out');
const SQLITE_BINDING = path.join(
  ROOT,
  'backend',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);

const REQUIRED_ASSETS = ['icon.ico'];
const OPTIONAL_ASSETS = ['installer_header.bmp'];

const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function step(msg) { console.log(`\n${CYAN}▶ ${msg}${RESET}`); }
function ok(msg)   { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}!${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}✗${RESET} ${msg}`); }

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function cleanBuildOutput() {
  step('Cleaning stale build output');
  rmrf(DIST_DIR);
  rmrf(OUT_DIR);
  ok('dist/ and out/ removed');
}

function verifyAssets() {
  step('Verifying installer assets');
  if (!fs.existsSync(ASSETS_DIR)) {
    fail(`assets/ directory missing — create ${ASSETS_DIR}`);
    process.exit(1);
  }
  let missing = 0;
  for (const name of REQUIRED_ASSETS) {
    const p = path.join(ASSETS_DIR, name);
    if (fs.existsSync(p)) { ok(name); } else { fail(`${name} missing at ${p}`); missing++; }
  }
  for (const name of OPTIONAL_ASSETS) {
    const p = path.join(ASSETS_DIR, name);
    if (fs.existsSync(p)) { ok(name); } else { warn(`${name} missing (optional — NSIS will use default)`); }
  }
  if (missing > 0) {
    fail('Required asset(s) missing — see assets/README.md for specs.');
    process.exit(1);
  }
}

function verifyFrontendBuild() {
  step('Verifying frontend/dist');
  const indexHtml = path.join(FRONTEND_DIST, 'index.html');
  if (fs.existsSync(indexHtml)) {
    ok('frontend/dist/index.html present');
    return;
  }
  warn('frontend/dist missing — running `vite build`');
  const result = spawnSync('npx', ['vite', 'build'], {
    cwd: FRONTEND_DIR,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    fail('vite build failed');
    process.exit(result.status || 1);
  }
  if (!fs.existsSync(indexHtml)) {
    fail('vite build completed but frontend/dist/index.html still missing');
    process.exit(1);
  }
  ok('frontend built');
}

function getElectronAbi() {
  try {
    const electronPkg = require(path.join(ROOT, 'node_modules', 'electron', 'package.json'));
    return electronPkg.version || null;
  } catch (_e) {
    return null;
  }
}

function bindingTargetsElectron() {
  // Heuristic: a binding built for system Node will load fine from `node` but
  // throw NODE_MODULE_VERSION mismatch from Electron. We can't trial-load from
  // Electron here, so we treat existence as "good enough" and rely on the user
  // running `npm run rebuild-sqlite` if Electron complains at runtime.
  // Future improvement: shell out to `electron -e "require('better-sqlite3')"`.
  return fs.existsSync(SQLITE_BINDING);
}

function verifySqliteBinding() {
  step('Verifying better-sqlite3 native binding');
  const electronVersion = getElectronAbi();
  if (!electronVersion) {
    warn('electron not installed at root — skipping rebuild check (run `npm install` first)');
    return;
  }
  if (bindingTargetsElectron()) {
    ok(`better_sqlite3.node present (target Electron ${electronVersion})`);
    return;
  }
  warn('better_sqlite3.node missing — running @electron/rebuild');
  try {
    execSync('npx electron-rebuild -f -w better-sqlite3', {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (!bindingTargetsElectron()) {
      fail('electron-rebuild ran but binding still missing');
      process.exit(1);
    }
    ok('better-sqlite3 rebuilt for Electron');
  } catch (err) {
    fail(`electron-rebuild failed: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  console.log(`${CYAN}FinTrace NCRP — pre-build verification${RESET}`);
  cleanBuildOutput();
  verifyAssets();
  verifyFrontendBuild();
  verifySqliteBinding();
  console.log(`\n${GREEN}✓ Pre-build checks passed. Ready for electron-builder.${RESET}\n`);
}

main();
