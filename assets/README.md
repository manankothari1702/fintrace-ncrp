# FinTrace NCRP — installer assets

Files in this directory are bundled into the Windows installer by
electron-builder (via the `extraFiles` and `nsis.*` keys in the root
`package.json`).

## Required

### `icon.ico`
- **Spec:** 256 × 256 (multi-resolution `.ico` containing 16, 32, 48, 64, 128
  and 256 px variants is ideal).
- **Used as:** application icon (window, taskbar, .exe icon, installer icon,
  uninstaller icon, Start Menu / Desktop shortcut).
- **How to create from a PNG with ImageMagick:**
  ```powershell
  magick convert icon.png -define icon:auto-resize=16,32,48,64,128,256 icon.ico
  ```
  Online converters (e.g. https://icoconvert.com/) also work in a pinch.

If `icon.ico` is missing electron-builder falls back to the default Electron
icon and the prebuild script will refuse to package — see `scripts/prebuild.js`.

## Optional (recommended for polish)

### `installer_header.bmp`
- **Spec:** **497 × 58 px**, 24-bit BMP (no alpha).
  NSIS rejects PNGs and any size other than 497×58 will be center-cropped.
- **Used as:** banner shown across the top of every page of the NSIS installer.
- **How to create with ImageMagick:**
  ```powershell
  magick convert header.png -resize 497x58! BMP3:installer_header.bmp
  ```
  The `BMP3:` prefix forces the legacy 24-bit format that NSIS understands;
  newer BMP variants silently fail.

If `installer_header.bmp` is missing the installer falls back to the default
NSIS banner — the build still succeeds.

## Notes

- All assets in this folder are also copied verbatim into
  `resources/assets/` inside the installed app via the `extraFiles` block,
  so the running app can read them at `path.join(process.resourcesPath, 'assets', '…')`.
- Keep this folder small — every byte ends up in the installer.
