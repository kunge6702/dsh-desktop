# DSH Desktop

DSH Desktop is a thin Electron shell around `@deepseek-ai/dsh`'s local web UI. It starts `dsh web` on an OS-assigned loopback port, opens only the exact origin reported by that child, and keeps the service available from the system tray.

## Development

This project pins Electron 39.0.0 because its embedded Node.js 22.20 satisfies DSH's Node engine. The supervisor also refuses to start on an incompatible Electron runtime.

```text
npm install
npm test
npm start
```

The selected workspace is stored in Electron's user-data directory. The first launch creates `Documents/DSH Workspace`; use the tray menu to select another directory.

## Packaging

Run `npm run dist` on the target platform. The build keeps the application in an asar archive while unpacking native modules and helper files under `node_modules` so `node-pty`, `koffi`, and their platform helpers can be loaded by the embedded DSH process. DSH ships Windows/macOS node-pty prebuilds, so the packager deliberately does not rebuild native modules against Electron; Linux release builders must compile node-pty during `npm install`. An `afterPack` check rejects packages that omit the target platform's frontend, native modules, or PTY helpers.

Windows executable resource editing is disabled in the default unsigned build so packaging works without Developer Mode's symbolic-link privilege. A signed release should provide its own icon/certificate and enable `win.signAndEditExecutable` in the release configuration.

Before shipping a release, run a packaged smoke test that starts `dsh web --port 0`, loads `/`, exercises `/api` and both WebSocket downlinks, and invokes terminal and directory-picker paths. Verify the unpacked `.node` files and helper executables for the target platform; a successful development launch is not sufficient.

The loopback HTTP server is not an authentication boundary. This shell assumes a single-user local threat model: other local processes can attempt to reach the random port while the app is running. Electron navigation is constrained to the exact loopback origin, permissions are denied by default, and Node integration/sandbox settings are locked down.

Each packaged build generates `THIRD_PARTY_NOTICES.txt` from the runtime packages actually included in that artifact. Electron's `LICENSE.electron.txt` and Chromium's `LICENSES.chromium.html` are shipped alongside it.
