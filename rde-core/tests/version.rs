//! The version shown in the app must be the version that was released.
//!
//! `web/index.html` carries its own `VERSION` constant because the page has no
//! way to read `Cargo.toml` at runtime — it is a static file. That makes drift
//! possible: bump the workspace version, ship, and every bug report names the
//! previous release. This test is the thing that stops it, so the two can only
//! ever be changed together.

use std::path::Path;

#[test]
fn page_version_matches_the_crate() {
    let index = Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/index.html");
    let html = std::fs::read_to_string(&index).expect("read web/index.html");

    let marker = "const VERSION = \"";
    let start = html.find(marker).expect("web/index.html declares a VERSION") + marker.len();
    let end = start + html[start..].find('"').expect("VERSION is a quoted string");
    let page = &html[start..end];

    assert_eq!(
        page,
        env!("CARGO_PKG_VERSION"),
        "web/index.html says {page}, Cargo.toml says {} — bump both",
        env!("CARGO_PKG_VERSION")
    );
}
