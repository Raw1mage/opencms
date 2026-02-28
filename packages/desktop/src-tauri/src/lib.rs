mod cli;
mod constants;
#[cfg(windows)]
mod job_object;
#[cfg(target_os = "linux")]
pub mod linux_display;
mod logging;
mod markdown;
mod os;
mod server;
mod window_customizer;
mod windows;

use futures::{
    FutureExt,
    future::{self, Shared},
};
#[cfg(windows)]
use job_object::*;
use std::{
    env,
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Listener, Manager, RunEvent, State, ipc::Channel};
#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_specta::Event;
use tokio::{
    sync::{oneshot, watch},
    time::timeout,
};

use crate::cli::{sqlite_migration::SqliteMigrationProgress, sync_cli};
use crate::constants::*;
use crate::server::get_saved_server_url;
use crate::windows::{LoadingWindow, MainWindow};

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
pub(crate) struct ServerReadyData {
    url: String,
    username: Option<String>,
    password: Option<String>,
    is_sidecar: bool,
}

#[derive(Clone, Copy, serde::Serialize, specta::Type, Debug)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum InitStep {
    ServerWaiting,
    SqliteWaiting,
    Done,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
enum WslPathMode {
    Windows,
    Linux,
}

struct InitState {
    current: watch::Receiver<InitStep>,
}

#[derive(Clone)]
struct ServerState {
    child: Arc<Mutex<Option<CommandChild>>>,
    status: future::Shared<oneshot::Receiver<Result<ServerReadyData, String>>>,
}

impl ServerState {
    pub fn new(
        child: Option<CommandChild>,
        status: Shared<oneshot::Receiver<Result<ServerReadyData, String>>>,
    ) -> Self {
        Self {
            child: Arc::new(Mutex::new(child)),
            status,
        }
    }

    pub fn set_child(&self, child: Option<CommandChild>) {
        *self.child.lock().unwrap() = child;
    }
}

#[tauri::command]
#[specta::specta]
fn kill_sidecar(app: AppHandle) {
    let Some(server_state) = app.try_state::<ServerState>() else {
        tracing::info!("Server not running");
        return;
    };

    let Some(server_state) = server_state
        .child
        .lock()
        .expect("Failed to acquire mutex lock")
        .take()
    else {
        tracing::info!("Server state missing");
        return;
    };

    let _ = server_state.kill();

    tracing::info!("Killed server");
}

fn get_logs() -> String {
    logging::tail()
}

#[tauri::command]
#[specta::specta]
async fn await_initialization(
    state: State<'_, ServerState>,
    init_state: State<'_, InitState>,
    events: Channel<InitStep>,
) -> Result<ServerReadyData, String> {
    let mut rx = init_state.current.clone();

    let events = async {
        let e = *rx.borrow();
        let _ = events.send(e);

        while rx.changed().await.is_ok() {
            let step = *rx.borrow_and_update();

            let _ = events.send(step);

            if matches!(step, InitStep::Done) {
                break;
            }
        }
    };

    future::join(state.status.clone(), events)
        .await
        .0
        .map_err(|_| "Failed to get server status".to_string())?
}

#[tauri::command]
#[specta::specta]
fn check_app_exists(app_name: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        os::windows::check_windows_app(app_name)
    }

    #[cfg(target_os = "macos")]
    {
        check_macos_app(app_name)
    }

    #[cfg(target_os = "linux")]
    {
        check_linux_app(app_name)
    }
}

#[tauri::command]
#[specta::specta]
fn resolve_app_path(app_name: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        os::windows::resolve_windows_app_path(app_name)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On macOS/Linux, just return the app_name as-is since
        // the opener plugin handles them correctly
        Some(app_name.to_string())
    }
}

#[tauri::command]
#[specta::specta]
fn open_in_powershell(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return os::windows::open_in_powershell(path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("PowerShell is only supported on Windows".to_string())
    }
}

#[cfg(target_os = "macos")]
fn check_macos_app(app_name: &str) -> bool {
    // Check common installation locations
    let mut app_locations = vec![
        format!("/Applications/{}.app", app_name),
        format!("/System/Applications/{}.app", app_name),
    ];

    if let Ok(home) = std::env::var("HOME") {
        app_locations.push(format!("{}/Applications/{}.app", home, app_name));
    }

    for location in app_locations {
        if std::path::Path::new(&location).exists() {
            return true;
        }
    }

    // Also check if command exists in PATH
    Command::new("which")
        .arg(app_name)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LinuxDisplayBackend {
    Wayland,
    Auto,
}

#[tauri::command]
#[specta::specta]
fn get_display_backend() -> Option<LinuxDisplayBackend> {
    #[cfg(target_os = "linux")]
    {
        let prefer = linux_display::read_wayland().unwrap_or(false);
        return Some(if prefer {
            LinuxDisplayBackend::Wayland
        } else {
            LinuxDisplayBackend::Auto
        });
    }

    #[cfg(not(target_os = "linux"))]
    None
}

#[tauri::command]
#[specta::specta]
fn set_display_backend(_app: AppHandle, _backend: LinuxDisplayBackend) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let prefer = matches!(_backend, LinuxDisplayBackend::Wayland);
        return linux_display::write_wayland(&_app, prefer);
    }

    #[cfg(not(target_os = "linux"))]
    Ok(())
}

#[cfg(target_os = "linux")]
fn check_linux_app(_app_name: &str) -> bool {
    return true;
}

#[tauri::command]
#[specta::specta]
fn wsl_path(path: String, mode: Option<WslPathMode>) -> Result<String, String> {
    if !cfg!(windows) {
        return Ok(path);
    }

    let flag = match mode.unwrap_or(WslPathMode::Linux) {
        WslPathMode::Windows => "-w",
        WslPathMode::Linux => "-u",
    };

    let output = if path.starts_with('~') {
        let suffix = path.strip_prefix('~').unwrap_or("");
        let escaped = suffix.replace('"', "\\\"");
        let cmd = format!("wslpath {flag} \"$HOME{escaped}\"");
        Command::new("wsl")
            .args(["-e", "sh", "-lc", &cmd])
            .output()
            .map_err(|e| format!("Failed to run wslpath: {e}"))?
    } else {
        Command::new("wsl")
            .args(["-e", "wslpath", flag, &path])
            .output()
            .map_err(|e| format!("Failed to run wslpath: {e}"))?
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err("wslpath failed".to_string());
        }
        return Err(stderr);
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = make_specta_builder();

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    export_types(&builder);

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    let _ = std::process::Command::new("killall")
        .arg("opencode-cli")
        .output();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window when another instance is launched
            if let Some(window) = app.get_webview_window(MainWindow::LABEL) {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                .with_denylist(&[LoadingWindow::LABEL])
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(crate::window_customizer::PinchZoomDisablePlugin)
        .plugin(tauri_plugin_decorum::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            let handle = app.handle().clone();

            let log_dir = app
                .path()
                .app_log_dir()
                .expect("failed to resolve app log dir");
            // Hold the guard in managed state so it lives for the app's lifetime,
            // ensuring all buffered logs are flushed on shutdown.
            handle.manage(logging::init(&log_dir));

            builder.mount_events(&handle);
            tauri::async_runtime::spawn(initialize(handle));

            Ok(())
        });

    if UPDATER_ENABLED {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                tracing::info!("Received Exit");

                kill_sidecar(app.clone());
            }
        });
}

fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        // Then register them (separated by a comma)
        .commands(tauri_specta::collect_commands![
            kill_sidecar,
            cli::install_cli,
            await_initialization,
            server::get_default_server_url,
            server::set_default_server_url,
            server::get_wsl_config,
            server::set_wsl_config,
            get_display_backend,
            set_display_backend,
            markdown::parse_markdown_command,
            check_app_exists,
            wsl_path,
            resolve_app_path,
            open_in_powershell
        ])
        .events(tauri_specta::collect_events![
            LoadingWindowComplete,
            SqliteMigrationProgress
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
}

fn export_types(builder: &tauri_specta::Builder<tauri::Wry>) {
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");
}

#[cfg(test)]
#[test]
fn test_export_types() {
    let builder = make_specta_builder();
    export_types(&builder);
}

#[derive(tauri_specta::Event, serde::Deserialize, specta::Type)]
struct LoadingWindowComplete;

async fn initialize(app: AppHandle) {
    tracing::info!("Initializing app");

    let (init_tx, init_rx) = watch::channel(InitStep::ServerWaiting);

    setup_app(&app, init_rx);
    spawn_cli_sync_task(app.clone());

    let (server_ready_tx, server_ready_rx) = oneshot::channel();
    let server_ready_rx = server_ready_rx.shared();
    app.manage(ServerState::new(None, server_ready_rx.clone()));

    // SQLite migration handling:
    // We only do this if the sqlite db doesn't exist, and we're expecting the sidecar to create it
    // First, we spawn a task that listens for SqliteMigrationProgress events that can
    // come from any invocation of the sidecar CLI. The progress is captured by a stdout stream interceptor.
    // Then in the loading task, we wait for sqlite migration to complete before
    // starting our health check against the server, otherwise long migrations could result in a timeout.
    let needs_sqlite_migration = option_env!("OPENCODE_SQLITE").is_some() && !sqlite_file_exists();
    let sqlite_done = needs_sqlite_migration.then(|| {
        tracing::info!(
            path = %opencode_db_path().expect("failed to get db path").display(),
            "Sqlite file not found, waiting for it to be generated"
        );

        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Arc::new(Mutex::new(Some(done_tx)));

        let init_tx = init_tx.clone();
        let id = SqliteMigrationProgress::listen(&app, move |e| {
            let _ = init_tx.send(InitStep::SqliteWaiting);

            if matches!(e.payload, SqliteMigrationProgress::Done) {
                if let Ok(mut lock) = done_tx.lock() {
                    if let Some(done_tx) = lock.take() {
                        let _ = done_tx.send(());
                    }
                }
            }
        });

        let app = app.clone();
        tokio::spawn(done_rx.map(async move |_| {
            app.unlisten(id);
        }))
    });

    // Setup server connection (may spawn sidecar process)
    tracing::info!("Setting up server connection");
    let server_connection = setup_server_connection(app.clone()).await;
    tracing::info!("Server connection setup");

    // Show loading window during SQLite migration
    let loading_window = if needs_sqlite_migration {
        LoadingWindow::create(&app).ok()
    } else {
        None
    };

    // Wait for SQLite migration to complete before proceeding
    if let Some(sqlite_done) = sqlite_done {
        let _ = sqlite_done.await;
    }

    // Resolve server readiness — wait for the sidecar stdout URL or use existing
    let server_data = match server_connection {
        ServerConnection::CLI {
            child,
            ready_rx,
            password,
        } => {
            match timeout(Duration::from_secs(30), ready_rx).await {
                Ok(Ok(Ok(url))) => {
                    tracing::info!(%url, "Sidecar server ready");

                    #[cfg(windows)]
                    {
                        let job_state = app.state::<JobObjectState>();
                        job_state.assign_pid(child.pid());
                    }

                    app.state::<ServerState>().set_child(Some(child));

                    let data = ServerReadyData {
                        url,
                        username: Some("opencode".to_string()),
                        password: Some(password),
                        is_sidecar: true,
                    };
                    let _ = server_ready_tx.send(Ok(data.clone()));
                    data
                }
                Ok(Ok(Err(e))) => {
                    let _ = child.kill();
                    let msg = format!(
                        "Failed to spawn OpenCode Server ({e}). Logs:\n{}",
                        get_logs()
                    );
                    let _ = server_ready_tx.send(Err(msg.clone()));
                    tracing::error!("{msg}");
                    return;
                }
                Ok(Err(_)) => {
                    let _ = child.kill();
                    let msg = format!(
                        "Server channel closed unexpectedly. Logs:\n{}",
                        get_logs()
                    );
                    let _ = server_ready_tx.send(Err(msg.clone()));
                    tracing::error!("{msg}");
                    return;
                }
                Err(_) => {
                    let _ = child.kill();
                    let msg = format!(
                        "Server startup timed out after 30s. Logs:\n{}",
                        get_logs()
                    );
                    let _ = server_ready_tx.send(Err(msg.clone()));
                    tracing::error!("{msg}");
                    return;
                }
            }
        }
        ServerConnection::Existing { url } => {
            let data = ServerReadyData {
                url,
                username: None,
                password: None,
                is_sidecar: false,
            };
            let _ = server_ready_tx.send(Ok(data.clone()));
            data
        }
    };

    let _ = init_tx.send(InitStep::Done);
    tracing::info!("Server ready, creating main window");

    // Create main window pointing to the server URL (web frontend)
    MainWindow::create(&app, &server_data).expect("Failed to create main window");

    if let Some(loading_window) = loading_window {
        let _ = loading_window.close();
    }
}

fn setup_app(app: &tauri::AppHandle, init_rx: watch::Receiver<InitStep>) {
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    app.deep_link().register_all().ok();

    #[cfg(windows)]
    app.manage(JobObjectState::new());

    app.manage(InitState { current: init_rx });
}

fn spawn_cli_sync_task(app: AppHandle) {
    tokio::spawn(async move {
        if let Err(e) = sync_cli(app) {
            tracing::error!("Failed to sync CLI: {e}");
        }
    });
}

enum ServerConnection {
    Existing {
        url: String,
    },
    CLI {
        child: CommandChild,
        ready_rx: oneshot::Receiver<Result<String, String>>,
        password: String,
    },
}

async fn setup_server_connection(app: AppHandle) -> ServerConnection {
    let custom_url = get_saved_server_url(&app).await;

    tracing::info!(?custom_url, "Attempting server connection");

    if let Some(url) = &custom_url
        && server::check_health_or_ask_retry(&app, url).await
    {
        tracing::info!(%url, "Connected to custom server");
        // If the default server is local, skip spawning an extra sidecar.
        if server::is_localhost_url(url) {
            return ServerConnection::Existing { url: url.clone() };
        }
        // For remote default server, keep fallback sidecar behavior.
    }

    // Only check for already-running local server when OPENCODE_PORT is explicitly set
    let explicit_port = get_explicit_port();
    if let Some(port) = explicit_port {
        let local_url = format!("http://127.0.0.1:{port}");
        tracing::debug!(url = %local_url, "Checking health of local server");
        if server::check_health(&local_url, None).await {
            tracing::info!(url = %local_url, "Health check OK, using existing server");
            return ServerConnection::Existing { url: local_url };
        }
    }

    let password = uuid::Uuid::new_v4().to_string();
    // Use explicit port if set, otherwise 0 to let Bun auto-assign
    let port = explicit_port.unwrap_or(0);
    let hostname = "127.0.0.1";

    tracing::info!("Spawning new local server");
    let (child, ready_rx) = cli::serve(&app, hostname, port, &password);

    ServerConnection::CLI {
        child,
        ready_rx,
        password,
    }
}

/// Returns the explicit OPENCODE_PORT if set by env var, otherwise None.
fn get_explicit_port() -> Option<u32> {
    option_env!("OPENCODE_PORT")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("OPENCODE_PORT").ok())
        .and_then(|port_str| port_str.parse().ok())
}

fn sqlite_file_exists() -> bool {
    let Ok(path) = opencode_db_path() else {
        return true;
    };

    path.exists()
}

fn opencode_db_path() -> Result<PathBuf, &'static str> {
    let xdg_data_home = env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty());

    let data_home = match xdg_data_home {
        Some(v) => PathBuf::from(v),
        None => {
            let home = dirs::home_dir().ok_or("cannot determine home directory")?;
            home.join(".local").join("share")
        }
    };

    Ok(data_home.join("opencode").join("opencode.db"))
}

