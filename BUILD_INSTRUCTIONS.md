# FinTrace NCRP — Windows Build Guide

End-to-end instructions for building the **FinTrace NCRP** Windows installer
(`FinTrace NCRP Setup 0.3.0.exe`) from a fresh checkout on a clean Windows
machine.

---

## 1. Prerequisites

Install these in order. Each link goes to the official source.

| Tool | Version | Why it's needed |
|------|---------|-----------------|
| [Node.js LTS](https://nodejs.org/) | 18.x or newer (24.x tested) | Runs npm + build scripts |
| [Python](https://www.python.org/downloads/) | 3.10–3.12 | node-gyp requires it to compile better-sqlite3 |
| [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | latest | C++ toolchain for native modules; install the **“Desktop development with C++”** workload |
| [Git for Windows](https://git-scm.com/download/win) | latest | Clone the repo |

After installing Visual Studio Build Tools, open a **new** PowerShell window so
the updated PATH takes effect.

Verify the toolchain:

```powershell
node -v          # v18.x or newer
npm -v           # 9.x or newer
python --version # 3.10-3.12
```

> **Tip.** If `npm install` later complains about missing `cl.exe` or `node-gyp`
> can't find MSBuild, the C++ workload was not installed. Re-run the Visual
> Studio Installer and tick **“Desktop development with C++”**.

---

## 2. Clone and install

```powershell
git clone <repo-url> "FinTrace NCRP"
cd "FinTrace NCRP"

# Root: Electron + electron-builder + electron-updater + electron-rebuild
npm install

# Backend: express, better-sqlite3 (native), xlsx, pdfkit, …
cd backend
npm install
cd ..

# Frontend: React + Vite
cd frontend
npm install
cd ..
```

The root `postinstall` script invokes `electron-builder install-app-deps`,
which automatically rebuilds native modules (better-sqlite3) for the
bundled Electron version. **No manual rebuild is usually needed.**

---

## 3. Rebuild native modules for Electron (only if needed)

If you ever upgrade Electron, hit a `NODE_MODULE_VERSION` mismatch at runtime,
or upgraded Node.js after installing dependencies, force a rebuild:

```powershell
npm run rebuild-sqlite
```

This runs `npx electron-rebuild -f -w better-sqlite3` against the bundled
Electron's Node ABI (not your system Node), and replaces
`backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node` with a
binary the packaged app can load.

---

## 4. Build the frontend

```powershell
npm run build:frontend
```

This shells into `frontend/` and runs `vite build`, producing the static
bundle at `frontend/dist/`. The Electron main process loads this folder via
`loadFile()` in packaged builds.

You can verify the build works in dev *before* packaging:

```powershell
# Terminal 1 — Vite dev server (renderer)
cd frontend ; npm run dev

# Terminal 2 — Electron pointing at the dev server
npm run dev:electron
```

---

## 5. Add the installer icon

Drop an `icon.ico` (multi-resolution, 256×256 ideal) into the `assets/`
folder. See [`assets/README.md`](assets/README.md) for specs and ImageMagick
recipes. Without it the prebuild script will refuse to package.

Optionally add `assets/installer_header.bmp` (497×58, BMP3) for a branded NSIS
banner.

---

## 6. Build the installer

```powershell
npm run build:win
```

This orchestrates the full pipeline:

1. **`prebuild`** (`scripts/prebuild.js`) — cleans `dist/` + `out/`, verifies
   assets, builds the frontend if missing, runs `@electron/rebuild` if the
   native binding is missing.
2. **`build:frontend`** — `vite build`.
3. **`electron-builder --win`** — packages the app into an NSIS installer.

Expect the build to take 2–5 minutes on first run (Electron is downloaded and
cached at `%LOCALAPPDATA%\electron\Cache`). Subsequent builds are faster.

---

## 7. Find the output

```
dist/
├── FinTrace NCRP Setup 0.3.0.exe   ← the installer you ship
├── win-unpacked/                   ← unpackaged app for quick smoke-test
└── builder-effective-config.yaml   ← effective electron-builder config (debug)
```

Smoke-test the unpacked build directly without installing:

```powershell
.\dist\win-unpacked\"FinTrace NCRP.exe"
```

---

## 8. Install and verify

```powershell
.\dist\"FinTrace NCRP Setup 0.3.0.exe"
```

The installer:
- prompts for an install location (user can change it),
- creates a Desktop shortcut and Start Menu entry,
- registers an uninstaller in **Add/Remove Programs**.

After install, launch FinTrace NCRP from the Start Menu and verify:

- [ ] The splash window appears, then the main window opens within ~5 s.
- [ ] Uploading a real NCRP CompleteTrail export succeeds (e.g. one of the
      reference files in the repo root, `32712250107145 (1).xlsx`). The bundled
      `sample_ncrp.xlsx` was retired — the validation harness now runs against the
      real gold cases.
- [ ] Exporting the PDF dossier and the Excel workbook each opens a native
      "Save As" dialog, and the saved files land where you chose (a copy is also
      kept in `%APPDATA%\FinTrace NCRP\exports\`).
- [ ] SQLite file exists at `%APPDATA%\FinTrace NCRP\fintrace.db`.
- [ ] No browser console errors (open via Ctrl+Shift+I — DevTools are
      available in unpacked builds; disable in production by removing
      `openDevTools` from `electron/main.js`).

---

## 9. Test on a clean Windows VM

Recommended before shipping any release:

1. Spin up a fresh Windows 10/11 VM (Hyper-V, VirtualBox, or Parallels).
2. **Do NOT install Node.js, Python, or VS Build Tools.** The whole point is to
   verify the installer is self-contained.
3. Copy `FinTrace NCRP Setup 0.3.0.exe` to the VM and run it.
4. Walk through the install wizard, launch the app, repeat the smoke test from
   step 8.
5. Uninstall via **Settings → Apps & features** and confirm:
   - the Desktop / Start Menu shortcuts are removed,
   - `%APPDATA%\FinTrace NCRP\` is preserved (user data; intentional).

If the app fails to launch on the clean VM, the most common culprit is a
better-sqlite3 ABI mismatch — re-run **step 3** on the build machine and
repackage.

---

## 10. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Error: The specified module could not be found … better_sqlite3.node` | Run `npm run rebuild-sqlite`, then `npm run build:win` again. |
| `gyp ERR! find Python` during `npm install` | Install Python 3.10–3.12 and add it to PATH. |
| `MSB8036: The Windows SDK version was not found` | Open Visual Studio Installer → modify Build Tools → add the latest **Windows 11 SDK**. |
| `nsis ERR! invalid bitmap` | `installer_header.bmp` is the wrong size or format — must be **497×58, 24-bit BMP3**. See [`assets/README.md`](assets/README.md). |
| Frontend loads but `/api/*` returns 404 | Backend didn't start — check `%APPDATA%\FinTrace NCRP\logs\main.log`. |
| Installer is 200+ MB | Expected — Electron runtime is ~120 MB. Use `7z` compression in `build.nsis` if you need it smaller. |

---

## 11. Version bumps

1. Update `version` in the root `package.json` (e.g. `0.1.0` → `0.1.1`).
2. Update `frontend/package.json` and `backend/package.json` to match, plus the
   `APP_VERSION` constant in `frontend/src/components/Sidebar.jsx` (the version
   shown in the sidebar footer).
3. Re-run `npm run build:win`. The new installer name reflects the version:
   `FinTrace NCRP Setup 0.1.1.exe`.

---

## 12. Auto-updates (future)

`electron-updater` is wired into `electron/main.js` as a stub
(`autoUpdater.checkForUpdatesAndNotify()`). To enable real updates:

1. Pick a publish provider (`generic` server, GitHub Releases, S3, etc.).
2. Add a `publish` block to `build` in the root `package.json`.
3. Re-run `npm run build:win` — electron-builder will emit a `latest.yml`
   manifest alongside the installer.
4. Host both files on the chosen feed; the running app will pick up the next
   release automatically.

See [electron-builder publish docs](https://www.electron.build/configuration/publish)
for the available providers.
