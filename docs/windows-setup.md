# Windows Setup (Tauri)

This guide walks through running and building Specterm natively on Windows via
the Tauri backend, plus fixes for issues we hit along the way.

## Prerequisites

1. **Rust** (stable, MSVC toolchain)

   ```powershell
   winget install Rustlang.Rustup
   rustup default stable-msvc
   ```

2. **Microsoft C++ Build Tools** — install the "Desktop development with C++"
   workload (provides the MSVC linker Tauri needs).

   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools
   ```

3. **WebView2 Runtime** — preinstalled on Windows 11. On older builds install it
   from the Microsoft Evergreen distributable.

4. **Node.js 18+**

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

5. **Tauri CLI v2** (installed as a dev dependency by `npm install`, no global
   install required).

## Run in dev

```powershell
npm install
npm run tauri dev
```

The first build compiles the Rust backend and may take several minutes. Later
runs are incremental.

## Build an installer

```powershell
npm run tauri build
```

The NSIS installer and the standalone `.exe` land under
`src-tauri/target/release/bundle/`.

## Electron dev on Windows

`dev:electron` sets an env var inline, which `cmd.exe`/PowerShell do not parse
the way bash does. We use [`cross-env`](https://www.npmjs.com/package/cross-env)
so the same script works on every OS:

```powershell
npm run dev:electron
```

---

## Troubleshooting

### Terminal opens but you can't type (no shell on Windows)

**Symptom:** the Tauri window starts, the terminal renders, but keystrokes do
nothing — no prompt, no echo.

**Cause:** the PTY spawn hardcoded `SHELL` → `/bin/bash`, which does not exist
on Windows. The child process failed to launch, so there was nothing connected
to read input.

**Fix:** `resolve_shell()` in `src-tauri/src/commands/pty.rs` now picks a real
shell per platform:

- Honor `$SHELL` if the user set one.
- On Windows, prefer PowerShell Core (`pwsh.exe` under `%ProgramFiles%`),
  falling back to built-in `powershell.exe`.
- On Unix, fall back to `/bin/bash`.

Set `SHELL` (e.g. to `C:\Windows\System32\cmd.exe` or a Git Bash path) to
override the default.

### Terminal opens in the wrong directory

The startup directory previously had a hardcoded developer path. It now defaults
to the user's home directory via `home_dir()`, which reads `HOME` then
`USERPROFILE` (the Windows equivalent). Pass an explicit `cwd` to `spawnPty` to
override.

### `electron .` ignores the dev server URL

If the Electron window loads the production bundle instead of the Vite dev
server, the `VITE_DEV_SERVER_URL` env var was not set — bare `VAR=value cmd`
syntax fails on Windows shells. Make sure you run the npm script (which uses
`cross-env`) rather than the raw command.

### Linker / `link.exe` not found

The MSVC C++ Build Tools workload is missing or not on PATH. Reinstall the
"Desktop development with C++" workload and reopen the terminal so PATH updates
take effect.

### WebView2 errors on launch

Install the WebView2 Evergreen Runtime from Microsoft. Windows 11 ships with it;
some Windows 10 images do not.
