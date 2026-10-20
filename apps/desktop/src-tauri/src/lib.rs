use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[derive(Default)]
struct EngineState {
    child: Mutex<Option<Child>>,
}

struct AppPrefs {
    close_to_tray: Mutex<bool>,
}

#[derive(Serialize, Clone)]
struct EngineInfo {
    port: u16,
    token: String,
    spawned: bool,
    pid: i64,
}

fn env_var(names: [&str; 2]) -> Option<String> {
    for name in names {
        if let Ok(value) = std::env::var(name) {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn copy_dir_recursive(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

// Mirrors the engine's data dir resolution (engine/src/paths.js): env override, then a one-time
// move of ~/.sql-crew to ~/.lazy-sql, keeping the legacy folder if it cannot be moved or copied.
fn data_dir() -> PathBuf {
    if let Some(dir) = env_var(["LAZY_SQL_DATA_DIR", "SQL_CREW_DATA_DIR"]) {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .unwrap_or_default();
    let modern = PathBuf::from(&home).join(".lazy-sql");
    let legacy = PathBuf::from(&home).join(".sql-crew");
    if modern.exists() || !legacy.exists() {
        return modern;
    }
    if std::fs::rename(&legacy, &modern).is_ok() {
        return modern;
    }
    if copy_dir_recursive(&legacy, &modern).is_ok() {
        return modern;
    }
    legacy
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(400)).is_ok()
}

fn read_fresh_serve_instance() -> Option<(u16, String, i64)> {
    let dir = data_dir().join("instances");
    let entries = std::fs::read_dir(dir).ok()?;
    let now = now_ms();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if !matches!(value["app"].as_str(), Some("lazy-sql" | "linkit-sql" | "sql-crew"))
            || value["mode"].as_str() != Some("serve")
        {
            continue;
        }
        let heartbeat = value["heartbeatAt"].as_u64().unwrap_or(0);
        if now.saturating_sub(heartbeat) > 8000 {
            continue;
        }
        let Some(port) = value["port"].as_u64() else {
            continue;
        };
        if !port_open(port as u16) {
            continue;
        }
        let Some(token) = value["token"].as_str() else {
            continue;
        };
        let pid = value["pid"].as_i64().unwrap_or(0);
        return Some((port as u16, token.to_string(), pid));
    }
    None
}

fn clean_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    path
}

fn resolve_engine_entry(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(env_path) = env_var(["LAZY_SQL_ENGINE_ENTRY", "SQL_CREW_ENGINE_ENTRY"]) {
        let candidate = PathBuf::from(env_path);
        if candidate.exists() {
            return Ok(clean_path(candidate));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join("resources").join("lazy-sql-engine.mjs"),
            resource_dir.join("lazy-sql-engine.mjs"),
        ] {
            if candidate.exists() {
                return Ok(clean_path(candidate));
            }
        }
    }
    let dev_entry = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("engine")
        .join("src")
        .join("index.js");
    if dev_entry.exists() {
        return Ok(clean_path(dev_entry.canonicalize().unwrap_or(dev_entry)));
    }
    Err("The LAZY SQL engine was not found. Build it with `npm run bundle` in the engine folder, then retry.".to_string())
}

#[tauri::command]
async fn ensure_engine(app: AppHandle, state: tauri::State<'_, EngineState>) -> Result<EngineInfo, String> {
    if let Some((port, token, pid)) = read_fresh_serve_instance() {
        return Ok(EngineInfo {
            port,
            token,
            spawned: false,
            pid,
        });
    }

    {
        let mut guard = state.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    let entry = resolve_engine_entry(&app)?;
    let mut command = Command::new("node");
    command
        .arg(&entry)
        .arg("--serve")
        .arg("--parent-pid")
        .arg(std::process::id().to_string());
    if let Some(parent) = entry.parent() {
        command.current_dir(parent);
    }
    // GUI apps pass invalid stdio handles to children; give the engine clean handles
    // and keep its stderr in a log file for diagnostics.
    command.stdin(Stdio::null()).stdout(Stdio::null());
    let log_path = data_dir().join("engine.log");
    let _ = std::fs::create_dir_all(data_dir());
    match std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(mut file) => {
            use std::io::Write;
            let _ = writeln!(file, "--- spawn: node {:?} --serve --parent-pid {} ---", entry, std::process::id());
            match file.try_clone() {
                Ok(cloned) => {
                    command.stderr(Stdio::from(cloned));
                }
                Err(_) => {
                    command.stderr(Stdio::null());
                }
            }
        }
        Err(_) => {
            command.stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start the LAZY SQL engine — is Node.js (>=22) installed and on PATH? ({error})"))?;
    let pid = child.id() as i64;
    *state.child.lock().unwrap() = Some(child);

    for _ in 0..75 {
        std::thread::sleep(std::time::Duration::from_millis(120));
        if let Some((port, token, _)) = read_fresh_serve_instance() {
            return Ok(EngineInfo {
                port,
                token,
                spawned: true,
                pid,
            });
        }
    }
    Err("The LAZY SQL engine started but did not report ready in time.".to_string())
}

/// The main window is built in code (not in tauri.conf.json) so dialog mode can start with
/// no main window at all. A configured window would be created for every process — including
/// `--review` — and show the app shell next to the review window.
fn build_main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("LAZY SQL")
        .inner_size(1180.0, 780.0)
        .min_inner_size(940.0, 600.0)
        .center()
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(true)
        .visible(true)
        .build()
        .map_err(|error| error.to_string())
}

fn build_review_window(app: &AppHandle, query: &str) -> Result<tauri::WebviewWindow, String> {
    WebviewWindowBuilder::new(app, "review", WebviewUrl::App(query.into()))
        .title("LAZY SQL — Review")
        .inner_size(720.0, 800.0)
        .min_inner_size(540.0, 460.0)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .resizable(true)
        .center()
        .visible(false)
        .build()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn hide_review_window(app: AppHandle) {
    // Dialog mode: this process exists only to show the review window — hiding it would leave
    // a headless process behind, so close the whole app instead.
    if app.get_webview_window("main").is_none() {
        app.exit(0);
        return;
    }
    if let Some(window) = app.get_webview_window("review") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_close_to_tray(app: AppHandle, value: bool) {
    let prefs = app.state::<AppPrefs>();
    *prefs.close_to_tray.lock().unwrap() = value;
}

#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("Path not found: {path}"));
    }
    #[cfg(target_os = "windows")]
    {
        if target.is_dir() {
            Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
        } else {
            Command::new("explorer")
                .arg(format!("/select,{path}"))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// `lazy-sql.exe --review <base> <token> <reviewId>` — dialog mode: the engine session that
/// requested the review spawns this process itself; it shows only the review window (no main
/// window, no tray, no engine supervision) and exits as soon as the window is closed.
fn review_args() -> Option<(String, String, String)> {
    let args: Vec<String> = std::env::args().collect();
    let index = args.iter().position(|arg| arg == "--review")?;
    Some((
        args.get(index + 1)?.clone(),
        args.get(index + 2)?.clone(),
        args.get(index + 3)?.clone(),
    ))
}

fn run_review_dialog(base: String, token: String, review_id: String) {
    let query = format!("index.html?view=review&base={base}&token={token}&review={review_id}");
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![hide_review_window])
        .setup(move |app| {
            let window = build_review_window(app.handle(), &query)?;
            let _ = window.show();
            let _ = window.set_focus();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building the LAZY SQL review dialog");
}

pub fn run() {
    if let Some((base, token, review_id)) = review_args() {
        run_review_dialog(base, token, review_id);
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        .manage(AppPrefs {
            close_to_tray: Mutex::new(true),
        })
        .invoke_handler(tauri::generate_handler![
            ensure_engine,
            hide_review_window,
            quit_app,
            set_close_to_tray,
            get_platform,
            reveal_path
        ])
        .setup(|app| {
            build_main_window(app.handle())?;

            let show_item = MenuItemBuilder::with_id("show", "Show LAZY SQL").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("LAZY SQL — SQL execution with human review")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let app = window.app_handle();
                    let close_to_tray = *app.state::<AppPrefs>().close_to_tray.lock().unwrap();
                    if close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        app.exit(0);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building LAZY SQL")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let state = app_handle.state::<EngineState>();
                let child = state.child.lock().unwrap().take();
                if let Some(mut child) = child {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
