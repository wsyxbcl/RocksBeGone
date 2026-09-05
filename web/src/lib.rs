//! WASM bindings for the Caracal RDE reviewer (SPEC §5). Thin layer over
//! `rde-core`: parse MD json bytes, cluster suspicious groups, and export a
//! removal mask on the original document. All heavy work is `rde-core`; this
//! crate only crosses the JS boundary as bytes + small JSON DTOs (SPEC §5.1).

use rde_core::{apply_removals, find_suspicious, DetRef, MdDocument, RdeOptions};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Default RDE options as JSON, for initializing the UI controls.
#[wasm_bindgen]
pub fn default_options() -> String {
    serde_json::to_string(&RdeOptions::default()).expect("options serialize")
}

/// Ambiguity-safe path matching (SPEC §6.2): map each json `file` path to a
/// picked file. `json_paths_json` and `picked_paths_json` are JSON string
/// arrays; returns a JSON array of `PathMatch` (`{"status":"matched",...}` etc.).
#[wasm_bindgen]
pub fn match_paths(json_paths_json: &str, picked_paths_json: &str) -> Result<String, JsValue> {
    let json_paths: Vec<String> = serde_json::from_str(json_paths_json).map_err(to_js)?;
    let picked_paths: Vec<String> = serde_json::from_str(picked_paths_json).map_err(to_js)?;
    let matches = rde_core::match_paths(&json_paths, &picked_paths);
    serde_json::to_string(&matches).map_err(to_js)
}

/// A parsed MegaDetector document held in WASM as the immutable original
/// (SPEC §6.1). Clustering and export both run against it.
#[wasm_bindgen]
pub struct RdeSession {
    doc: MdDocument,
}

#[wasm_bindgen]
impl RdeSession {
    /// Parse MD json bytes — hand the `File`'s `ArrayBuffer` straight in to skip
    /// the JS-string copy (SPEC §2.1).
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<RdeSession, JsValue> {
        let doc = MdDocument::from_slice(bytes).map_err(to_js)?;
        Ok(Self { doc })
    }

    pub fn image_count(&self) -> usize {
        self.doc.images().len()
    }

    pub fn total_detections(&self) -> usize {
        self.doc.total_detections()
    }

    /// The `file` path of every image, indexed by image_index — used to match to
    /// picked files and to locate the pixels of suspicious images (SPEC §6.2).
    /// (P1: returns all paths; targeting only suspicious images is a later
    /// optimization for very large datasets.)
    pub fn image_files(&self) -> String {
        let files: Vec<&str> = self
            .doc
            .images()
            .iter()
            .map(|image| image.get("file").and_then(|v| v.as_str()).unwrap_or(""))
            .collect();
        serde_json::to_string(&files).expect("files serialize")
    }

    /// `[[image_index, frame_rate], …]` for the document's video entries (SPEC
    /// §2.2). Sparse — the frontend joins it to the paths from `image_files` to
    /// decide which media need a frame decode, and at what rate (SPEC §7).
    pub fn video_frame_rates(&self) -> String {
        serde_json::to_string(&self.doc.video_frame_rates()).expect("rates serialize")
    }

    /// Every detection on one media as JSON, suspicious or not, so the preview can
    /// draw what else the detector found — a suspicious box overlapping a real
    /// animal is exactly the call a reviewer needs help with.
    pub fn detections_of(&self, image_index: usize) -> Result<String, JsValue> {
        serde_json::to_string(&self.doc.detections_of(image_index)).map_err(to_js)
    }

    /// The document's `detection_categories` (`"1" -> "animal"`), for labelling.
    pub fn category_names(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.doc.category_names()).map_err(to_js)
    }

    /// Cluster suspicious groups (SPEC §3). `options_json` is an `RdeOptions`;
    /// returns the groups as a JSON array (the review DTO, SPEC §5.1). Cheap and
    /// pure, so the UI can re-run it on every parameter change.
    pub fn find(&self, options_json: &str) -> Result<String, JsValue> {
        let options: RdeOptions = serde_json::from_str(options_json).map_err(to_js)?;
        let groups = find_suspicious(&self.doc, &options);
        serde_json::to_string(&groups).map_err(to_js)
    }

    /// Apply a removal mask on the original document (SPEC §6.3).
    /// `remove_refs_json` is a JSON array of `DetRef`; returns filtered MD json
    /// bytes for a Blob download.
    pub fn export(&self, remove_refs_json: &str) -> Result<Vec<u8>, JsValue> {
        let refs: Vec<DetRef> = serde_json::from_str(remove_refs_json).map_err(to_js)?;
        Ok(apply_removals(&self.doc, &refs).to_json_vec())
    }
}

fn to_js(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
