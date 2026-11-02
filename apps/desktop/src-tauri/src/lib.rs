//! Tauri shell around `bridge-core`. Commands are thin wrappers; all policy
//! lives in the engine.

use std::sync::Arc;

use bridge_core::{AcceptOptions, Bridge, BridgeConfig, Settings, UiEvent};
use connection_policy::AccessLevel;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;

pub const DEFAULT_RELAY_URL: &str = "http://127.0.0.1:8787";

struct AppState {
    bridge: Bridge,
}

#[derive(Debug, Serialize)]
struct CmdError {
    message: String,
}

impl From<bridge_core::BridgeError> for CmdError {
    fn from(e: bridge_core::BridgeError) -> Self {
        let message = match e {
            bridge_core::BridgeError::User(m) => m,
            bridge_core::BridgeError::Internal(m) => {
                tracing::error!("internal: {m}");
                "Something went wrong. Details are in Diagnostics.".into()
            }
        };
        Self { message }
    }
}

type CmdResult<T> = Result<T, CmdError>;

#[tauri::command]
fn get_snapshot(state: State<'_, AppState>) -> bridge_core::Snapshot {
    state.bridge.snapshot()
}

#[tauri::command]
async fn refresh_providers(state: State<'_, AppState>) -> CmdResult<Vec<bridge_core::providers::ProviderView>> {
    Ok(state.bridge.refresh_providers().await)
}

#[tauri::command]
async fn install_adapter(state: State<'_, AppState>, provider: String) -> CmdResult<String> {
    Ok(state.bridge.install_adapter(&provider).await?)
}

#[tauri::command]
async fn provider_sign_in(state: State<'_, AppState>, provider: String) -> CmdResult<()> {
    state.bridge.provider_sign_in(&provider).await?;
    // Poll for completion of the official browser flow for a while.
    let b = state.bridge.clone();
    tokio::spawn(async move {
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let list = b.refresh_providers().await;
            if list.iter().any(|p| p.id == provider && p.state == bridge_core::providers::ProviderState::Ready) {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn provider_sign_out(state: State<'_, AppState>, provider: String) -> CmdResult<()> {
    Ok(state.bridge.provider_sign_out(&provider).await?)
}

#[tauri::command]
async fn set_api_key(state: State<'_, AppState>, provider: String, key: String) -> CmdResult<()> {
    Ok(state.bridge.set_api_key(&provider, &key).await?)
}

#[tauri::command]
async fn add_custom_agent(state: State<'_, AppState>, name: String, program: String, args: Vec<String>) -> CmdResult<()> {
    Ok(state.bridge.add_custom_agent(&name, &program, args).await?)
}

#[tauri::command]
async fn remove_custom_agent(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.bridge.remove_custom_agent(&id).await?)
}

#[tauri::command]
async fn begin_pairing(state: State<'_, AppState>, input: String) -> CmdResult<bridge_core::PairingRequestView> {
    Ok(state.bridge.begin_pairing(&input).await?)
}

#[tauri::command]
async fn accept_pairing(state: State<'_, AppState>, pairing_id: String, opts: AcceptOptions) -> CmdResult<bridge_core::GrantView> {
    Ok(state.bridge.accept_pairing(&pairing_id, opts).await?)
}

#[tauri::command]
async fn reject_pairing(state: State<'_, AppState>, pairing_id: String) -> CmdResult<()> {
    Ok(state.bridge.reject_pairing(&pairing_id).await?)
}

#[tauri::command]
async fn revoke_grant(state: State<'_, AppState>, connection_id: String) -> CmdResult<()> {
    Ok(state.bridge.revoke_grant(&connection_id).await?)
}

#[tauri::command]
async fn revoke_all(state: State<'_, AppState>) -> CmdResult<()> {
    Ok(state.bridge.revoke_all().await?)
}

#[tauri::command]
fn forget_grant(state: State<'_, AppState>, connection_id: String) -> CmdResult<()> {
    Ok(state.bridge.forget_grant(&connection_id)?)
}

#[tauri::command]
async fn set_grant_paused(state: State<'_, AppState>, connection_id: String, paused: bool) -> CmdResult<()> {
    Ok(state.bridge.set_grant_paused(&connection_id, paused).await?)
}

#[tauri::command]
async fn update_grant(state: State<'_, AppState>, connection_id: String, require_task_approval: bool, access: AccessLevel) -> CmdResult<()> {
    Ok(state.bridge.update_grant(&connection_id, require_task_approval, access).await?)
}

#[tauri::command]
async fn set_paused(app: AppHandle, state: State<'_, AppState>, paused: bool) -> CmdResult<()> {
    state.bridge.set_paused(paused).await?;
    update_tray(&app, paused);
    Ok(())
}

#[tauri::command]
async fn approve_task(state: State<'_, AppState>, task_id: String, approve: bool) -> CmdResult<()> {
    Ok(state.bridge.approve_task(&task_id, approve).await?)
}

#[tauri::command]
async fn cancel_task(state: State<'_, AppState>, task_id: String) -> CmdResult<()> {
    state.bridge.cancel_task(&task_id, "stopped on this computer").await;
    Ok(())
}

#[tauri::command]
fn respond_permission(state: State<'_, AppState>, request_id: String, choice: String) -> CmdResult<()> {
    Ok(state.bridge.respond_permission(&request_id, &choice)?)
}

#[tauri::command]
async fn start_local_task(state: State<'_, AppState>, provider: String, workspace: String, prompt: String) -> CmdResult<String> {
    Ok(state.bridge.start_local_task(&provider, &workspace, &prompt).await?)
}

#[tauri::command]
fn update_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> CmdResult<Settings> {
    use tauri_plugin_autostart::ManagerExt;
    let s = state.bridge.update_settings(settings)?;
    let autostart = app.autolaunch();
    let enabled = autostart.is_enabled().unwrap_or(false);
    if s.launch_at_login && !enabled {
        let _ = autostart.enable();
    } else if !s.launch_at_login && enabled {
        let _ = autostart.disable();
    }
    Ok(s)
}

#[tauri::command]
async fn get_diagnostics(state: State<'_, AppState>) -> CmdResult<bridge_core::Diagnostics> {
    Ok(state.bridge.diagnostics().await)
}

#[tauri::command]
fn clear_diagnostics(state: State<'_, AppState>) -> CmdResult<()> {
    Ok(state.bridge.clear_diagnostics()?)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn handle_deep_links(app: &AppHandle, urls: Vec<String>) {
    for url in urls {
        if !url.to_lowercase().starts_with("remoteacp://") {
            continue;
        }
        show_main(app);
        let bridge = app.state::<AppState>().bridge.clone();
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = bridge.begin_pairing(&url).await {
                let msg = match e {
                    bridge_core::BridgeError::User(m) => m,
                    bridge_core::BridgeError::Internal(_) => "Could not open this pairing link".into(),
                };
                let _ = app2.emit("bridge://event", UiEvent::Error { message: msg });
            }
        });
    }
}

const TRAY_PAUSE_ID: &str = "tray-pause";

fn update_tray(app: &AppHandle, paused: bool) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let label = if paused { "Resume bridge" } else { "Pause bridge" };
        if let Ok(menu) = build_tray_menu(app, label) {
            let _ = tray.set_menu(Some(menu));
        }
        let _ = tray.set_tooltip(Some(if paused { "Remote ACP Bridge — paused" } else { "Remote ACP Bridge" }));
    }
}

fn build_tray_menu(app: &AppHandle, pause_label: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "tray-open", "Open Remote ACP Bridge", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, TRAY_PAUSE_ID, pause_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &pause, &quit])
}

pub fn run() {
    // When launched as `--acp-mock-agent`, act as the built-in test ACP agent.
    if std::env::args().nth(1).as_deref() == Some("--acp-mock-agent") {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(agent_host::mock::run());
        return;
    }
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            show_main(app);
            handle_deep_links(app, argv.into_iter().skip(1).collect());
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| bridge_core::default_data_dir());
            let exe = std::env::current_exe().expect("current exe");
            let secrets: Arc<dyn bridge_core::secrets::SecretStore> = Arc::from(bridge_core::secrets::default_store());
            let bridge = tauri::async_runtime::block_on(Bridge::start(BridgeConfig {
                data_dir,
                default_relay_url: std::env::var("REMOTE_ACP_RELAY_URL").unwrap_or_else(|_| DEFAULT_RELAY_URL.into()),
                app_version: env!("CARGO_PKG_VERSION").into(),
                mock_command: Some((exe, vec!["--acp-mock-agent".into()])),
                secrets,
                in_memory_db: false,
            }))
            .map_err(|e| Box::new(std::io::Error::other(e.to_string())))?;
            let paused = bridge.is_paused();
            app.manage(AppState { bridge: bridge.clone() });

            // Forward engine events to the UI and raise OS notifications.
            let mut rx = bridge.subscribe();
            let h2 = handle.clone();
            let b2 = bridge.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let ev = match rx.recv().await {
                        Ok(ev) => ev,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let _ = h2.emit("bridge://event", UiEvent::StateChanged);
                            continue;
                        }
                        Err(_) => break,
                    };
                    let notify = b2.settings().notifications;
                    let focused = h2
                        .get_webview_window("main")
                        .and_then(|w| w.is_focused().ok())
                        .unwrap_or(false);
                    let note: Option<(String, String)> = match &ev {
                        UiEvent::PermissionRequested { title, service_name, .. } => Some((
                            "Permission needed".into(),
                            format!("{}: {}", service_name.clone().unwrap_or_else(|| "Agent".into()), title),
                        )),
                        UiEvent::TaskApprovalRequested { service_name, .. } => Some((
                            "New task request".into(),
                            format!("{} wants to start a task", service_name.clone().unwrap_or_else(|| "A website".into())),
                        )),
                        UiEvent::PairingRequested { service_name, .. } => {
                            show_main(&h2);
                            Some(("Connection request".into(), format!("{service_name} wants to connect")))
                        }
                        _ => None,
                    };
                    if let (true, false, Some((title, body))) = (notify, focused, note) {
                        let _ = h2.notification().builder().title(title).body(body).show();
                    }
                    let _ = h2.emit("bridge://event", ev);
                }
            });

            // Deep links (macOS delivers via on_open_url; others via argv).
            #[cfg(any(windows, target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();
            }
            let h3 = handle.clone();
            app.deep_link().on_open_url(move |event| {
                handle_deep_links(&h3, event.urls().into_iter().map(|u| u.to_string()).collect());
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                handle_deep_links(&handle, urls.into_iter().map(|u| u.to_string()).collect());
            }
            let argv: Vec<String> = std::env::args().skip(1).collect();
            handle_deep_links(&handle, argv);

            // Tray / menu-bar icon.
            let menu = build_tray_menu(&handle, if paused { "Resume bridge" } else { "Pause bridge" })?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Remote ACP Bridge")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-open" => show_main(app),
                    TRAY_PAUSE_ID => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let b = app.state::<AppState>().bridge.clone();
                            let paused = !b.is_paused();
                            let _ = b.set_paused(paused).await;
                            update_tray(&app, paused);
                        });
                    }
                    "tray-quit" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            app.state::<AppState>().bridge.shutdown().await;
                            app.exit(0);
                        });
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon_as_template(false);
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let keep = app.state::<AppState>().bridge.settings().keep_in_tray;
                if keep {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    let b = app.state::<AppState>().bridge.clone();
                    tauri::async_runtime::block_on(b.shutdown());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            refresh_providers,
            install_adapter,
            provider_sign_in,
            provider_sign_out,
            set_api_key,
            add_custom_agent,
            remove_custom_agent,
            begin_pairing,
            accept_pairing,
            reject_pairing,
            revoke_grant,
            revoke_all,
            forget_grant,
            set_grant_paused,
            update_grant,
            set_paused,
            approve_task,
            cancel_task,
            respond_permission,
            start_local_task,
            update_settings,
            get_diagnostics,
            clear_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Remote ACP Bridge");
}
