mod commands;

use commands::pty::PtyState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(PtyState::new())
        .invoke_handler(tauri::generate_handler![
            commands::spawn_pty,
            commands::write_pty,
            commands::resize_pty,
            commands::kill_pty,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
