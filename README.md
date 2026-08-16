# DSH Desktop

DSH Desktop is a thin Electron shell around `@deepseek-ai/dsh`'s local web UI. It starts `dsh web` on an OS-assigned loopback port, opens only the exact origin reported by that child, and keeps the service available from the system tray.

## Development

The lockfile pins Electron 39.8.10 because its embedded Node.js 22.22 satisfies DSH's Node engine. The supervisor also refuses to start on an incompatible Electron runtime.

```text
npm install
npm test
npm start
```

The selected workspace is stored in Electron's user-data directory. The first launch creates `Documents/DSH Workspace`; use the tray menu to select another directory. DSH Desktop runs as a single instance: launching it again, clicking its tray icon, or choosing **Show DSH** restores and focuses the existing window.

## Packaging

Run `npm run dist` on the target platform. Before packaging, a locked production-only install is prepared under `runtime/node_modules` and stored in `resources/dsh-runtime.asar`. Native modules and the packages that launch external helpers remain beside the archive in `dsh-runtime.asar.unpacked`; this keeps installation to a small number of files without breaking PTY, ripgrep, Koffi, Sharp, or DSH's profile module resolution. DSH ships Windows/macOS node-pty prebuilds, so the packager deliberately does not rebuild native modules against Electron; Linux release builders compile node-pty while preparing the runtime. An `afterPack` check extracts and verifies the exact archive, rejects missing dependency edges or native helpers, and caps the number of loose runtime files.

Windows executable resources are edited with the bundled `rcedit` tool so the application executable and NSIS installer use `assets/favicon.png` even on machines without Developer Mode. Local builds remain unsigned and avoid loading the signing-tool bundle. When `CSC_LINK` and `CSC_KEY_PASSWORD` are present, the release workflow enables electron-builder's signed resource-editing path instead; public distribution should configure those secrets to avoid the Windows "unknown publisher" warning.

Before shipping a release, run a packaged smoke test that starts `dsh web --port 0`, loads `/`, exercises `/api` and both WebSocket downlinks, and invokes terminal and directory-picker paths. Verify the unpacked `.node` files and helper executables for the target platform; a successful development launch is not sufficient.

The loopback HTTP server is not an authentication boundary. This shell assumes a single-user local threat model: other local processes can attempt to reach the random port while the app is running. Electron navigation is constrained to the exact loopback origin, permissions are denied by default, and Node integration/sandbox settings are locked down.

Each packaged build generates `THIRD_PARTY_NOTICES.txt` from the runtime packages actually included in that artifact. Electron's `LICENSE.electron.txt` and Chromium's `LICENSES.chromium.html` are shipped alongside it.

## Updates and releases

Installed builds check stable releases from [`kunge6702/dsh-desktop`](https://github.com/kunge6702/dsh-desktop) after startup and expose **检查更新…** in the tray menu. Downloads require confirmation; a downloaded update can be installed immediately or automatically on normal application exit. Development and unpacked builds do not contact the update service, and GitHub releases marked as pre-release are ignored.

The release workflow is triggered by a stable semantic-version tag that exactly matches `package.json`. For example, release `0.2.0` with:

```text
npm version 0.2.0 --no-git-tag-version
npm test
npm run check
git add package.json package-lock.json
git commit -m "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

GitHub Actions validates the tag, builds on Windows, and publishes the NSIS installer, blockmap, and `latest.yml` required by `electron-updater`. Add repository secrets named `CSC_LINK` and `CSC_KEY_PASSWORD` when a Windows signing certificate is available.

## License

The source code is available under the [MIT License](LICENSE). The license does not grant rights to the DeepSeek name or logo. Confirm permission for branded assets before redistributing them, or replace them with original project artwork.
