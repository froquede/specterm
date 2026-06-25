use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct PtyState {
    instances: Mutex<HashMap<u32, PtyInstance>>,
    next_id: Mutex<u32>,
}

struct PtyInstance {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: u32,
    data: Vec<u8>,
}

#[derive(Deserialize)]
pub struct SpawnOptions {
    cols: u16,
    rows: u16,
    cwd: Option<String>,
}

#[cfg(windows)]
fn resolve_shell() -> String {
    // Honor $SHELL only if it points at something Windows can actually launch.
    // When the app is started from Git Bash/MSYS, SHELL is a POSIX path like
    // `/usr/bin/bash` that CreateProcess can't run — using it would re-create
    // the original "terminal opens but won't type" bug, so fall through to
    // PowerShell instead.
    if let Ok(shell) = std::env::var("SHELL") {
        if std::path::Path::new(&shell).exists() {
            return shell;
        }
    }
    // Prefer PowerShell Core (pwsh) if installed, else built-in Windows PowerShell
    if let Ok(pf) = std::env::var("ProgramFiles") {
        let pwsh = std::path::Path::new(&pf).join("PowerShell\\7\\pwsh.exe");
        if pwsh.exists() {
            return pwsh.to_string_lossy().into_owned();
        }
    }
    "powershell.exe".to_string()
}

#[cfg(not(windows))]
fn resolve_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

/// Resolve the user's home directory. Windows exposes it as USERPROFILE,
/// Unix as HOME.
fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    state: State<'_, PtyState>,
    options: SpawnOptions,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let size = PtySize {
        rows: options.rows,
        cols: options.cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell = resolve_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    if let Some(cwd) = &options.cwd {
        cmd.cwd(cwd);
    } else if let Some(home) = home_dir() {
        cmd.cwd(home);
    }

    pair.slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Drop the slave — we only need the master side
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {}", e))?;

    let mut id_lock = state.next_id.lock().unwrap();
    let id = *id_lock;
    *id_lock += 1;
    drop(id_lock);

    state.instances.lock().unwrap().insert(
        id,
        PtyInstance {
            master: pair.master,
            writer,
        },
    );

    // Spawn reader thread that emits data events to the frontend
    let pty_id = id;
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let output = PtyOutput {
                        id: pty_id,
                        data: buf[..n].to_vec(),
                    };
                    if app.emit("pty-output", &output).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Shell exited — notify frontend
        let _ = app.emit("pty-exit", pty_id);
    });

    Ok(id)
}

#[tauri::command]
pub fn write_pty(state: State<'_, PtyState>, id: u32, data: Vec<u8>) -> Result<(), String> {
    let mut instances = state.instances.lock().unwrap();
    let instance = instances
        .get_mut(&id)
        .ok_or_else(|| format!("PTY {} not found", id))?;
    instance
        .writer
        .write_all(&data)
        .map_err(|e| format!("Write error: {}", e))?;
    instance
        .writer
        .flush()
        .map_err(|e| format!("Flush error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    state: State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let instances = state.instances.lock().unwrap();
    let instance = instances
        .get(&id)
        .ok_or_else(|| format!("PTY {} not found", id))?;
    instance
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn kill_pty(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut instances = state.instances.lock().unwrap();
    // Dropping the instance closes the master PTY, which signals the child process
    instances.remove(&id);
    Ok(())
}
