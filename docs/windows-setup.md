# Windows Setup

How to run and build Specterm on Windows, plus fixes for issues we hit along
the way.

## Prerequisites

1. **Node.js 18+**

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

2. **Microsoft C++ Build Tools** — install the "Desktop development with C++"
   workload. `node-pty` is a native addon and is rebuilt against Electron's ABI
   after every install, which needs the MSVC compiler.

   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools
   ```

## Run in dev

```powershell
npm install
npx electron-builder install-app-deps
npm run dev:electron
```

`dev:electron` sets an env var inline, which `cmd.exe`/PowerShell do not parse
the way bash does. We use [`cross-env`](https://www.npmjs.com/package/cross-env)
so the same script works on every OS.

## Build an installer

```powershell
npm run build:electron:win
```

The NSIS installer lands under `build-output/`.

---

## Troubleshooting

### Terminal opens but you can't type (no shell on Windows)

`node-pty` needs a real shell to spawn, and `SHELL` is unset on Windows. The
Electron main process (`electron/main.cjs`) defaults to `powershell.exe`; set
`SPECTERM_SHELL` (e.g. to `pwsh.exe` for PowerShell 7, or a Git Bash path) to
override it.

### Terminals don't open at all

The `node-pty` addon was built for Node, not Electron. Re-run
`npx electron-builder install-app-deps` after any `npm install` or `npm ci`.

### `electron .` ignores the dev server URL

If the Electron window loads the production bundle instead of the Vite dev
server, the `VITE_DEV_SERVER_URL` env var was not set — bare `VAR=value cmd`
syntax fails on Windows shells. Make sure you run the npm script (which uses
`cross-env`) rather than the raw command.

### Linker / `link.exe` not found

The MSVC C++ Build Tools workload is missing or not on PATH. Reinstall the
"Desktop development with C++" workload and reopen the terminal so PATH updates
take effect.
