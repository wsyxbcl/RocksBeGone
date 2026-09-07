//! How long does the webkitdirectory path's matching step actually take?
//!
//! The fallback hands `match_paths` every file the user picked — on a real
//! archive that is several times the number the json describes, because of
//! sidecars and unrelated output folders. Run it against a real pair to find
//! out whether the freeze people report is this, or the browser's enumeration
//! before this.
//!
//!   cargo run --release --example matchbench -- <md.json> <media root>

use std::time::Instant;

use rde_core::path::{match_paths, PathMatch};
use rde_core::MdDocument;

fn main() {
    let mut args = std::env::args().skip(1);
    let json = args.next().expect("usage: matchbench <md.json> <media root>");
    let root = args.next().expect("usage: matchbench <md.json> <media root>");

    let bytes = std::fs::read(&json).expect("read json");
    let t = Instant::now();
    let doc = MdDocument::from_slice(&bytes).expect("parse");
    let parse_ms = t.elapsed().as_secs_f64() * 1000.0;
    let json_paths: Vec<String> = doc
        .images()
        .iter()
        .filter_map(|i| i.get("file")?.as_str().map(str::to_owned))
        .collect();

    // What the browser would hand us: every file under the picked folder, as a
    // path relative to that folder's parent (that is what webkitRelativePath is).
    let t = Instant::now();
    let root_path = std::path::Path::new(&root);
    let base = root_path.parent().unwrap_or(root_path);
    let mut picked = Vec::new();
    let mut stack = vec![root_path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(rel) = p.strip_prefix(base) {
                picked.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let walk_ms = t.elapsed().as_secs_f64() * 1000.0;

    let t = Instant::now();
    let matches = match_paths(&json_paths, &picked);
    let match_ms = t.elapsed().as_secs_f64() * 1000.0;

    let mut matched = 0;
    let mut ambiguous = 0;
    let mut unmatched = 0;
    for m in &matches {
        match m {
            PathMatch::Matched { .. } => matched += 1,
            PathMatch::Ambiguous => ambiguous += 1,
            PathMatch::Unmatched => unmatched += 1,
        }
    }

    println!("json images     {}", json_paths.len());
    println!("picked files    {}", picked.len());
    println!("parse           {parse_ms:8.1} ms");
    println!("walk (native)   {walk_ms:8.1} ms   <- the browser's enumeration is the analogue");
    println!("match_paths     {match_ms:8.1} ms");
    println!("matched {matched}  ambiguous {ambiguous}  unmatched {unmatched}");
}
