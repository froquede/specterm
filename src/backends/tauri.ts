import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  readTextFile,
  writeTextFile as tauriWriteTextFile,
  readDir as tauriReadDir,
} from "@tauri-apps/plugin-fs";
import type {
  Backend,
  SpawnPtyOptions,
  FileEntry,
  FileEntryStats,
  DriveEntry,
  ProcessInfo,
  UnlistenFn,
  UpdaterEvent,
  TransferTab,
  WindowInit,
} from "./types";

interface PtyOutput {
  id: number;
  data: number[];
}

export class TauriBackend implements Backend {
  async spawnPty(opts: SpawnPtyOptions): Promise<number> {
    return invoke<number>("spawn_pty", { options: opts });
  }

  async writePty(id: number, data: string): Promise<void> {
    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(data));
    return invoke("write_pty", { id, data: bytes });
  }

  async resizePty(id: number, cols: number, rows: number): Promise<void> {
    return invoke("resize_pty", { id, cols, rows });
  }

  async killPty(id: number): Promise<void> {
    return invoke("kill_pty", { id });
  }

  // PTY handover between windows is part of the multi-window support below,
  // which this backend doesn't have — nothing ever releases or adopts here.
  async releasePty(_ids: number[]): Promise<void> {}

  async adoptPty(
    _id: number,
    _cols: number,
    _rows: number
  ): Promise<{ buffered: Uint8Array; exited: boolean }> {
    return { buffered: new Uint8Array(), exited: false };
  }

  // No `pty_cwd` command on the Tauri side yet; reporting null degrades to the
  // configured startup path, exactly as on a platform that can't answer.
  async ptyCwd(_id: number): Promise<string | null> {
    return null;
  }

  // Process inspection has no Tauri command yet. Empty answers are a supported
  // outcome everywhere (Windows reports nothing either), so panes here restore
  // as plain shells rather than resumed sessions.
  async ptyDescendants(
    _ids: number[]
  ): Promise<Record<number, ProcessInfo[]>> {
    return {};
  }

  async readProcessEnv(
    _pid: number,
    _names: string[]
  ): Promise<Record<string, string>> {
    return {};
  }

  async onPtyOutput(
    cb: (id: number, data: Uint8Array) => void
  ): Promise<UnlistenFn> {
    return listen<PtyOutput>("pty-output", (event) => {
      cb(event.payload.id, new Uint8Array(event.payload.data));
    });
  }

  async onPtyExit(cb: (id: number) => void): Promise<UnlistenFn> {
    return listen<number>("pty-exit", (event) => {
      cb(event.payload);
    });
  }

  async readTextFile(path: string): Promise<string> {
    return readTextFile(path);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    return tauriWriteTextFile(path, content);
  }

  async readDir(path: string): Promise<FileEntry[]> {
    const entries = await tauriReadDir(path);
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory,
    }));
  }

  // Tauri's readDir gives no mtimes, and the session providers are the only
  // caller — see ptyDescendants above for why an empty answer is safe.
  async readDirStats(_path: string): Promise<FileEntryStats[]> {
    return [];
  }

  async listDrives(): Promise<DriveEntry[]> {
    // TODO: implement a `list_drives` Tauri command (probe C:..Z: existence in
    // Rust) once the Tauri backend is completed. Electron is the shipping
    // Windows target today, so this stub keeps the interface satisfied.
    return [];
  }

  async revealInFileManager(path: string, isDirectory: boolean): Promise<void> {
    // Best-effort via the shell plugin's default-app open. It can open a folder
    // but can't reveal a file *selected* (that needs the opener plugin), so for
    // a file we open its containing directory instead. Electron is the shipping
    // target and gets the richer showItemInFolder reveal.
    const { open } = await import("@tauri-apps/plugin-shell");
    const target = isDirectory
      ? path
      : path.replace(/[\\/][^\\/]*$/, "") || path;
    await open(target);
  }

  async onFsChange(cb: () => void): Promise<UnlistenFn> {
    return listen("fs-change", () => cb());
  }

  async onOpenPath(cb: (path: string) => void): Promise<UnlistenFn> {
    // Tauri file-association / single-instance file delivery isn't wired on this
    // experimental backend yet; Electron is the shipping target. No-op unlisten.
    void cb;
    return () => {};
  }

  async clipboardHasImage(): Promise<boolean> {
    // Not yet wired on the Tauri backend; image paste is Electron-only for now.
    return false;
  }

  async clipboardReadText(): Promise<string> {
    // Tauri's webview generally allows navigator.clipboard; no native bridge yet.
    return navigator.clipboard.readText();
  }

  async clipboardWriteText(text: string): Promise<void> {
    return navigator.clipboard.writeText(text);
  }

  async getHomePath(): Promise<string> {
    return invoke<string>("get_home_path");
  }

  // No `get_hostname` command on the Tauri side yet. Blank means OSC 7 reports
  // are accepted only in their unambiguous local forms (empty host/localhost).
  async getHostname(): Promise<string> {
    return "";
  }

  async isFullscreen(): Promise<boolean> {
    return getCurrentWindow().isFullscreen();
  }

  async setFullscreen(value: boolean): Promise<void> {
    return getCurrentWindow().setFullscreen(value);
  }

  async onFullscreenChange(
    cb: (value: boolean) => void
  ): Promise<UnlistenFn> {
    // Tauri has no dedicated fullscreen event; resize fires on enter/leave, so
    // re-read the state from there.
    const win = getCurrentWindow();
    return win.onResized(async () => {
      cb(await win.isFullscreen());
    });
  }

  async setAttentionBadge(_count: number): Promise<void> {
    // Tauri exposes no badge/attention API from JS (Electron's setBadgeCount
    // and flashFrame have no counterpart), and Electron is the shipping target.
    // The in-window indicators — the tab chip and the pane title-bar — are
    // unaffected; only the outside-the-window signal is missing here.
  }

  async setWindowOpacity(_value: number): Promise<void> {
    // Tauri's window API exposes no JS setOpacity; honoring this would need a
    // native `set_window_opacity` command. Electron is the shipping target, so
    // this is a no-op stub (matching listDrives/clipboardHasImage) — the window
    // stays opaque under Tauri.
  }

  // Native decorations here, so there is nothing for the tab bar to draw.
  async drawsOwnWindowControls(): Promise<boolean> {
    return false;
  }

  async minimizeWindow(): Promise<void> {}

  async toggleMaximizeWindow(): Promise<boolean> {
    return false;
  }

  async closeWindow(): Promise<void> {}

  async isMaximized(): Promise<boolean> {
    return false;
  }

  async onMaximizedChange(_cb: (maximized: boolean) => void): Promise<UnlistenFn> {
    return () => {};
  }

  // Multi-window (extra windows, tearing a tab off into its own) is Electron-only
  // for now: it needs host-side window bookkeeping and PTY re-ownership that this
  // backend has no counterpart for. These stubs keep the single window it does
  // have working exactly as before — it just never gets a second one.
  async takeWindowInit(): Promise<WindowInit> {
    return { tabs: [] };
  }

  async newWindow(): Promise<void> {}

  // Nothing outlives the window here, so closing it is already quitting.
  async quitApp(): Promise<void> {}

  async dropTransfer(_tab: TransferTab): Promise<void> {}

  async onAdoptTab(_cb: (tab: TransferTab) => void): Promise<UnlistenFn> {
    return () => {};
  }

  // Nothing here can outlive the window, so a close is a close: the detach
  // request never fires and the rest are inert.
  async detachPtys(_ids: number[]): Promise<void> {}

  async onDetachRequest(_cb: () => void): Promise<UnlistenFn> {
    return () => {};
  }

  async parkSession(_tabs: TransferTab[]): Promise<void> {}

  setBackgroundSessions(_enabled: boolean): void {}

  // One window, and no host-side session storage — nothing to report to.
  pushLayout(_layout: { tabs: unknown[]; activeTabIndex: number } | null): void {}

  pushSessionPrefs(_prefs: {
    restoreLastSession: boolean;
    backgroundSessions: boolean;
    customTitleBar: boolean;
  }): void {}

  async reattachSession(): Promise<boolean> {
    return false;
  }

  // No host-side screen storage yet — a restored session comes back with its
  // layout and directories, and its panes start empty.
  async writeScreens(_screens: Record<string, string> | null): Promise<void> {}

  async readScreens(): Promise<Record<string, string>> {
    return {};
  }

  async detachedSessionCount(): Promise<number> {
    return 0;
  }

  // With one window there is nobody to sync with, so a broadcast has no
  // listeners and no receiver ever fires.
  broadcast(_channel: string, _payload?: unknown): void {}

  async onBroadcast(
    _cb: (channel: string, payload?: unknown) => void
  ): Promise<UnlistenFn> {
    return () => {};
  }

  // Self-update isn't wired on the experimental Tauri backend; Electron is the
  // shipping target with electron-updater. A check just reports "dev" through
  // the same event channel the store consumes, so the Settings button resolves
  // to the up-to-date state instead of sticking on "Checking…".
  private updaterCb: ((event: UpdaterEvent) => void) | null = null;

  async checkForUpdate(): Promise<void> {
    this.updaterCb?.({ status: "dev", version: __APP_VERSION__ });
  }

  async downloadUpdate(): Promise<void> {}

  async installUpdate(): Promise<void> {}

  async getCurrentVersion(): Promise<string> {
    return __APP_VERSION__;
  }

  async onUpdaterEvent(
    cb: (event: UpdaterEvent) => void
  ): Promise<UnlistenFn> {
    this.updaterCb = cb;
    return () => {
      this.updaterCb = null;
    };
  }
}
