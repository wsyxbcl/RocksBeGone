//! The double-click path: serve the app to this machine and open a browser.
//!
//! It exists because a browser will not load WebAssembly or module workers from
//! a `file://` page, so `index.html` cannot simply be opened. Nothing leaves the
//! machine — the socket is bound to loopback, and the only thing served is the
//! folder this binary sits in.
//!
//! No dependencies, on purpose: this is the piece a field biologist runs, and it
//! should be a single file that builds anywhere Rust does.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

/// Fixed, not "first free port". Saved sessions, the theme and the measured
/// decode settings are all stored per-origin by the browser, and an origin that
/// changes between runs quietly loses them.
const PORT: u16 = 8787;

fn main() {
    let root = site_root();
    if !root.join("index.html").is_file() {
        eprintln!(
            "No index.html next to this program (looked in {}).\n\
             Keep the launcher inside the unzipped folder — it serves whatever sits beside it.",
            root.display()
        );
        wait_for_enter();
        return;
    }

    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, PORT);
    let listener = match TcpListener::bind(addr) {
        Ok(listener) => listener,
        Err(_) => {
            // Almost always a second copy of this launcher, so open the browser
            // at the running one rather than reporting a port clash nobody can
            // act on.
            println!("Something is already serving port {PORT} — opening that.");
            open_browser(PORT);
            wait_for_enter();
            return;
        }
    };

    let url = format!("http://127.0.0.1:{PORT}/");
    println!("RocksBeGone is at {url}\nClose this window when you are done.");
    open_browser(PORT);

    for stream in listener.incoming().flatten() {
        let root = root.clone();
        // A thread each: crops are fetched several at a time, and a serial
        // server would make the reviewer wait on a queue of its own making.
        std::thread::spawn(move || {
            let _ = serve(stream, &root);
        });
    }
}

/// The folder the binary is in, not the working directory — double-clicking on
/// Windows starts the process in whatever directory Explorer feels like.
fn site_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn serve(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request = String::new();
    reader.read_line(&mut request)?;
    // Drain the headers; we do not need them, but the client expects them read.
    let mut line = String::new();
    while reader.read_line(&mut line)? > 2 {
        line.clear();
    }

    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        return respond(&mut stream, 405, "text/plain", b"only GET", method == "HEAD");
    }

    let path = match resolve(root, target) {
        Some(path) => path,
        None => return respond(&mut stream, 403, "text/plain", b"forbidden", false),
    };
    match fs::read(&path) {
        Ok(body) => respond(&mut stream, 200, content_type(&path), &body, method == "HEAD"),
        Err(_) => respond(&mut stream, 404, "text/plain", b"not found", false),
    }
}

/// Map a request target to a file inside `root`, or nothing.
///
/// Rejects any path that climbs out of the served folder. A loopback server is
/// still a server, and serving the user's home directory is one careless line
/// away.
fn resolve(root: &Path, target: &str) -> Option<PathBuf> {
    let target = target.split(['?', '#']).next().unwrap_or("/");
    let decoded = percent_decode(target);
    let relative = decoded.trim_start_matches('/');
    let relative = if relative.is_empty() { "index.html" } else { relative };

    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => path.push(part),
            // Anything else — .., a root, a Windows prefix — is not addressing a
            // file in the site.
            _ => return None,
        }
    }
    // Belt and braces: symlinks could still point outside.
    let canonical = path.canonicalize().ok()?;
    let root = root.canonicalize().ok()?;
    canonical.starts_with(root).then_some(canonical)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Types the app actually needs. `application/wasm` is not optional: the browser
/// refuses to instantiate a module served as anything else, and the failure
/// looks like a broken page rather than a wrong header.
fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "json" => "application/json",
        "css" => "text/css; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Method Not Allowed",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        body.len()
    )?;
    if !head_only {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn open_browser(port: u16) {
    let url = format!("http://127.0.0.1:{port}/");
    let opened = if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", &url]).spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&url).spawn()
    } else {
        Command::new("xdg-open").arg(&url).spawn()
    };
    if opened.is_err() {
        println!("Could not open a browser automatically — go to {url}");
    }
}

/// Double-clicked on Windows, the console vanishes the instant main returns and
/// any message with it.
fn wait_for_enter() {
    println!("\nPress Enter to close.");
    let _ = std::io::stdin().read(&mut [0u8]);
}
