//! Export must not invent, drop or reorder anything it was not asked to touch.
//!
//! Upstream has two open issues here, both caused by loading detections into a
//! dataframe and regenerating them on the way out: custom properties on a
//! detection are lost, and a `"failure": null` is added to every successful
//! image. We take a different route — the parsed document is kept whole and
//! export removes entries from it — so neither should be possible. These tests
//! are what makes that a fact rather than an argument about the design.

use rde_core::{apply_removals, DetRef, MdDocument};

const DOC: &str = r#"{
  "info": { "detector": "megadetector_v5a", "custom_run_id": "abc-123" },
  "detection_categories": { "1": "animal" },
  "images": [
    {
      "file": "cam/a.jpg",
      "custom_image_field": { "station": "A17", "nested": [1, 2, 3] },
      "detections": [
        { "category": "1", "conf": 0.9, "bbox": [0.1, 0.1, 0.1, 0.1], "custom_det_field": "keep-me" },
        { "category": "1", "conf": 0.8, "bbox": [0.5, 0.5, 0.1, 0.1], "classifications": [["x", 0.4]] }
      ]
    }
  ]
}"#;

fn parse(text: &str) -> MdDocument {
    MdDocument::from_slice(text.as_bytes()).expect("parse")
}

/// A custom property on a detection that survives the cut must come out
/// untouched — upstream's P0 bug.
#[test]
fn custom_detection_fields_survive_export() {
    let doc = parse(DOC);
    // Remove the second detection; the first must be returned verbatim.
    let out = apply_removals(&doc, &[DetRef { image_index: 0, detection_index: 1 }]);
    let value: serde_json::Value = serde_json::from_slice(&out.to_json_vec()).expect("reparse");

    let dets = value["images"][0]["detections"].as_array().expect("detections");
    assert_eq!(dets.len(), 1, "only the removed detection should be gone");
    assert_eq!(dets[0]["custom_det_field"], "keep-me");
    assert_eq!(dets[0]["conf"], 0.9);
}

/// Fields on the image and on the document are equally untouched.
#[test]
fn custom_image_and_info_fields_survive_export() {
    let doc = parse(DOC);
    let out = apply_removals(&doc, &[DetRef { image_index: 0, detection_index: 0 }]);
    let value: serde_json::Value = serde_json::from_slice(&out.to_json_vec()).unwrap();

    assert_eq!(value["info"]["custom_run_id"], "abc-123");
    assert_eq!(value["images"][0]["custom_image_field"]["station"], "A17");
    assert_eq!(value["images"][0]["custom_image_field"]["nested"][2], 3);
    // The surviving detection keeps its own extras too.
    assert_eq!(value["images"][0]["detections"][0]["classifications"][0][0], "x");
}

/// Nothing is added that was not in the input — upstream's stray
/// `"failure": null` on every successful image.
#[test]
fn export_invents_no_fields() {
    let doc = parse(DOC);
    let out = apply_removals(&doc, &[DetRef { image_index: 0, detection_index: 1 }]);
    let value: serde_json::Value = serde_json::from_slice(&out.to_json_vec()).unwrap();

    let image = value["images"][0].as_object().expect("image object");
    assert!(!image.contains_key("failure"), "export added a `failure` key");
    let mut keys: Vec<&str> = image.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["custom_image_field", "detections", "file"]);
}

/// Key order is part of what a file looks like in review; `preserve_order` keeps
/// it, so a diff of input against output shows only the removed detections.
#[test]
fn key_order_is_preserved() {
    let doc = parse(DOC);
    let out = apply_removals(&doc, &[]);
    let text = String::from_utf8(out.to_json_vec()).expect("utf-8");
    assert!(
        text.find("\"info\"") < text.find("\"detection_categories\""),
        "top-level key order changed"
    );
    assert!(
        text.find("\"file\"") < text.find("\"custom_image_field\""),
        "image key order changed"
    );
    // With nothing removed, export is the identity.
    let original: serde_json::Value = serde_json::from_str(DOC).unwrap();
    let exported: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(original, exported, "removing nothing should change nothing");
}
