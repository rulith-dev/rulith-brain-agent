//! Rulith Brain Agent's desktop shell: a window of its own for the agent's page.
//!
//! The agent is the one the zip package holds: Node runs start.mjs, which waits for Rulith Brain, starts the
//! forwarder and dsh's web app, and prints the page's address. This shell starts it without a console window, shows
//! what it says while it starts (Brain not running yet, the model loading), goes to the page when its address is
//! printed, and stops it when the window closes. Links to other sites open in the browser.
//!
//! The agent's page gets no way into this program: only the shell's own page (ui/, shown while the agent starts and
//! after it ended) may ask how the start goes and for another start. Tauri lets every page a window shows call an
//! app's commands, so each command looks at the window's address itself (asked_by_shell).
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{webview::NewWindowResponse, AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
#[cfg(windows)]
mod updates;

/// The line the launcher prints when the page is up: "Rulith Brain Agent: http://127.0.0.1:<port>/?token=<key>".
const SAYS_PAGE: &str = "Rulith Brain Agent: ";
/// The port the agent's page is asked to take, the same at every start while it is free: what a page keeps in the
/// window's storage goes by its address, port included - its settings, and that a newcomer has been shown the Brain
/// page (with another port at each start the introduction came at every start: seen on the second build).
const PAGE_PORT: u16 = 38481;
/// How many of the launcher's lines the shell's page is shown.
const KEPT_LINES: usize = 40;
/// The shell's own page, as the window's address has it (Windows; elsewhere tauri://localhost).
const SHELL_PAGE: &str = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };

struct Agent {
    /// the launcher's process while it runs
    pid: Option<u32>,
    /// what the launcher said, the last KEPT_LINES (never the page's address: it carries the page's key)
    lines: Vec<String>,
    /// whether the page's address was printed
    up: bool,
    /// the launcher's exit code, once it ended
    ended: Option<i32>,
    /// counts starts: a reader left over from an earlier start says nothing
    run: u64,
}

static AGENT: Mutex<Agent> = Mutex::new(Agent { pid: None, lines: Vec::new(), up: false, ended: None, run: 0 });
static CLOSING: AtomicBool = AtomicBool::new(false);

/// The shell's own data, %LOCALAPPDATA%\Rulith\BrainAgent: the window's storage and a short log. The agent's own
/// files (its dsh profile, the page's transcripts) are where the zip package keeps them: ~/.rulith-brain-agent.
fn home() -> PathBuf {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    local.join("Rulith").join("BrainAgent")
}

/// One line into logs\agent.log (started anew when it has grown past 1 MB).
fn log(line: &str) {
    let dir = home().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("agent.log");
    if std::fs::metadata(&file).map(|m| m.len() > 1 << 20).unwrap_or(false) {
        let _ = std::fs::remove_file(&file);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(f, "{line}");
    }
}

/// The agent as the installer laid it down beside this program: agent\node\node.exe and agent\app\start.mjs.
/// RULITH_BRAIN_AGENT_ROOT names another folder of that shape (a test run).
fn payload() -> Result<(PathBuf, PathBuf), String> {
    let root = match std::env::var_os("RULITH_BRAIN_AGENT_ROOT") {
        Some(named) => PathBuf::from(named),
        None => std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("The app's folder is unknown")?.join("agent"),
    };
    let (node, start) = (root.join("node").join("node.exe"), root.join("app").join("start.mjs"));
    if node.is_file() && start.is_file() {
        Ok((node, start))
    } else {
        Err(format!("The agent's files were not found in {}", root.display()))
    }
}

/// A line the launcher wrote: kept for the shell's page; the page's address takes the window there.
fn said(app: &AppHandle, run: u64, line: String) {
    let line = line.trim_end();
    if line.is_empty() {
        return;
    }
    let page = line.strip_prefix(SAYS_PAGE).filter(|rest| rest.starts_with("http://127.0.0.1:") || rest.starts_with("http://localhost:"));
    // The same Connection form serves the portable launcher and this window, even before Brain answers.
    let setup = line.strip_prefix("Brain connection page: ").filter(|rest| rest.starts_with("http://127.0.0.1:"));
    {
        let mut agent = AGENT.lock().unwrap();
        if agent.run != run {
            return;
        }
        match page {
            Some(_) => agent.up = true,
            None => {
                agent.lines.push(line.to_owned());
                let extra = agent.lines.len().saturating_sub(KEPT_LINES);
                agent.lines.drain(..extra);
            }
        }
    }
    match page.or(setup) {
        Some(address) => {
            log(if page.is_some() { "the agent's page is up" } else { "opening Brain connection settings" });
            if let (Some(window), Ok(url)) = (app.get_webview_window("main"), address.parse::<Url>()) {
                let _ = window.navigate(url);
            }
        }
        None => log(line),
    }
}

/// The launcher ended: the window goes back to the shell's own page, which says so and offers another start.
fn ended(app: &AppHandle, run: u64, code: i32) {
    {
        let mut agent = AGENT.lock().unwrap();
        if agent.run != run {
            return;
        }
        agent.pid = None;
        agent.up = false;
        agent.ended = Some(code);
    }
    log(&format!("the agent ended ({code})"));
    if CLOSING.load(Ordering::SeqCst) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let on_shell_page = window.url().map(|u| !matches!(u.host_str(), Some("127.0.0.1" | "localhost"))).unwrap_or(false);
        if !on_shell_page {
            if let Ok(url) = SHELL_PAGE.parse::<Url>() {
                let _ = window.navigate(url);
            }
        }
    }
}

/// Starts the agent: `node start.mjs --port <PAGE_PORT, or a free one> --no-open`, no console window, its lines read
/// as they come.
fn start(app: &AppHandle) -> Result<(), String> {
    let (node, script) = payload()?;
    let free = |port: u16| std::net::TcpListener::bind(("127.0.0.1", port)).and_then(|l| l.local_addr()).map(|a| a.port());
    let port = free(PAGE_PORT).or_else(|_| free(0)).map_err(|e| format!("No free port on this PC: {e}"))?;
    let mut command = Command::new(&node);
    command.arg(&script).args(["--port", &port.to_string(), "--no-open"])
        .env("RULITH_AGENT_DESKTOP", "1")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // (the folder the agent works in is chosen on its page; its process starts in the user's own folder)
    if let Some(dir) = std::env::var_os("USERPROFILE").map(PathBuf::from).filter(|d| d.is_dir()) {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| format!("The agent could not be started ({}): {e}", node.display()))?;
    let run = {
        let mut agent = AGENT.lock().unwrap();
        agent.run += 1;
        agent.pid = Some(child.id());
        agent.lines.clear();
        agent.up = false;
        agent.ended = None;
        agent.run
    };
    log(&format!("the agent starts (process {}, page port {port})", child.id()));
    // what it cannot do it writes to its error stream: said like the rest
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                said(&app, run, line);
            }
        });
    }
    let out = child.stdout.take();
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(out) = out {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                said(&app, run, line);
            }
        }
        let code = child.wait().ok().and_then(|status| status.code()).unwrap_or(-1);
        ended(&app, run, code);
    });
    Ok(())
}

/// A start that could not even begin is said on the shell's page like an agent that ended.
fn start_or_say(app: &AppHandle) {
    if let Err(why) = start(app) {
        log(&why);
        let mut agent = AGENT.lock().unwrap();
        agent.run += 1;
        agent.pid = None;
        agent.up = false;
        agent.lines = vec![why];
        agent.ended = Some(-1);
    }
}

/// The agent stopped with everything it started (the launcher's own child is dsh; a terminated launcher would leave
/// it running).
fn stop() {
    let pid = AGENT.lock().unwrap().pid.take();
    if let Some(pid) = pid {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            kill.creation_flags(0x0800_0000);
        }
        let _ = kill.status();
        log("the agent was stopped with the window");
    }
}

/// Whether an address is this program's or this PC's: the shell's page, the agent's page, the agent's Brain page.
fn local(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "about" | "data" | "blob") || matches!(url.host_str(), Some("tauri.localhost" | "127.0.0.1" | "localhost"))
}

/// Another site: the browser's to show.
fn outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// Whether a command is asked by the shell's own page: the agent's page, and anything it shows, asks in vain.
fn asked_by_shell(window: &tauri::WebviewWindow) -> Result<(), String> {
    match window.url() {
        Ok(url) if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") => Ok(()),
        _ => Err("Not for this page".into()),
    }
}

/// How the start goes, for the shell's page: the launcher's last lines, whether it runs, its exit code once it ended.
#[tauri::command]
fn agent_state(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    asked_by_shell(&window)?;
    let agent = AGENT.lock().unwrap();
    Ok(json!({"lines": agent.lines, "running": agent.pid.is_some(), "up": agent.up, "ended": agent.ended,
              "version": app.package_info().version.to_string()}))
}

/// Another start, asked on the shell's page after the agent ended.
#[tauri::command]
fn agent_start(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    asked_by_shell(&window)?;
    if AGENT.lock().unwrap().pid.is_none() {
        start_or_say(&app);
    }
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![agent_state, agent_start])
        .setup(|app| {
            let home = home();
            let _ = std::fs::create_dir_all(&home);
            let (to_navigation, to_window) = (app.handle().clone(), app.handle().clone());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Rulith Brain Agent")
                .inner_size(1280.0, 860.0)
                .min_inner_size(760.0, 560.0)
                .center()
                // the page's own storage (its key's cookie, its settings) stays with the shell's data
                .data_directory(home.join("webview"))
                .on_navigation(move |url| {
                    if local(url) {
                        return true;
                    }
                    outside(&to_navigation, url);
                    false
                })
                .on_new_window(move |url, _features| {
                    if local(&url) {
                        return NewWindowResponse::Allow;
                    }
                    outside(&to_window, &url);
                    NewWindowResponse::Deny
                })
                .build()?;
            #[cfg(windows)]
            updates::start(app.handle().clone());
            start_or_say(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    CLOSING.store(true, Ordering::SeqCst);
                    stop();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Rulith Brain Agent");
    app.run(|_app, event| {
        if let RunEvent::Exit = event {
            CLOSING.store(true, Ordering::SeqCst);
            stop();
        }
    });
}
