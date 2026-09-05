//! Reproduces the reference RDE `find` step and the demo ground truth
//! (`MegaDetector/rde-lab/demo/verify_rde.py` + `GROUND_TRUTH.md`), and exercises
//! the export-mask-on-original contract (SPEC §6.1/§6.3).

use std::collections::HashMap;

use rde_core::{apply_removals, find_suspicious, removals, DetRef, Decision, MdDocument, RdeOptions};

const DEMO: &[u8] = include_bytes!("fixtures/mdv1000_demo.json");

fn demo() -> MdDocument {
    MdDocument::from_slice(DEMO).expect("parse demo json")
}

#[test]
fn reproduces_reference_find() {
    let doc = demo();
    let groups = find_suspicious(&doc, &RdeOptions::default());

    // Exactly two suspicious groups, one per camera (SPEC/GROUND_TRUTH).
    assert_eq!(groups.len(), 2, "expected exactly 2 suspicious groups");

    let by_cam: HashMap<&str, _> = groups.iter().map(|g| (g.camera.as_str(), g)).collect();
    let cam_a = by_cam.get("cam_A").expect("cam_A group");
    let cam_b = by_cam.get("cam_B").expect("cam_B group");

    assert_eq!(cam_a.instances.len(), 25, "cam_A perch group = 25 instances");
    assert_eq!(cam_b.instances.len(), 22, "cam_B rock group = 22 instances");

    // Representative boxes ~ the perch / the rock.
    assert!(near(cam_a.rep_bbox, [0.40, 0.35, 0.12, 0.16]), "cam_A rep {:?}", cam_a.rep_bbox);
    assert!(near(cam_b.rep_bbox, [0.68, 0.62, 0.10, 0.11]), "cam_B rep {:?}", cam_b.rep_bbox);

    // Negatives never flagged: no group is the deer (excluded by size), the
    // persons (below threshold), or cam_exif (occurrence 1). Two groups total
    // already proves this, but assert the cameras explicitly.
    assert!(!by_cam.contains_key("cam_exif"));
}

#[test]
fn size_filter_excludes_big_boxes_and_partitions_by_camera() {
    let doc = demo();
    let groups = find_suspicious(&doc, &RdeOptions::default());
    // The deer boxes (area 0.225 > max 0.2) must not appear in any group.
    for g in &groups {
        assert!(g.rep_bbox[2] * g.rep_bbox[3] <= 0.2, "group box area under max");
    }
    // No group mixes cameras.
    for g in &groups {
        assert!(g.camera == "cam_A" || g.camera == "cam_B");
    }
}

#[test]
fn param_sweep_matches_ground_truth_notes() {
    let doc = demo();
    // Raising occurrence above 25 makes both groups disappear (GROUND_TRUTH).
    let opts = RdeOptions {
        occurrence_threshold: 26,
        ..RdeOptions::default()
    };
    assert_eq!(find_suspicious(&doc, &opts).len(), 0);

    // Lowering it below 22 changes nothing here (still exactly the two groups).
    let opts = RdeOptions {
        occurrence_threshold: 21,
        ..RdeOptions::default()
    };
    assert_eq!(find_suspicious(&doc, &opts).len(), 2);
}

#[test]
fn export_all_remove_drops_47() {
    let doc = demo();
    let groups = find_suspicious(&doc, &RdeOptions::default());
    let refs = removals(&groups); // every instance defaults to Remove
    assert_eq!(refs.len(), 47, "25 (cam_A) + 22 (cam_B)");

    let before = doc.total_detections();
    let filtered = apply_removals(&doc, &refs);
    assert_eq!(before - filtered.total_detections(), 47);
}

#[test]
fn per_instance_keep_drops_44() {
    let doc = demo();
    let mut groups = find_suspicious(&doc, &RdeOptions::default());

    // Keep the likely-real birds — the demo heuristic in verify_rde.py is
    // conf >= 0.5 (birds were drawn conf >= 0.55, branches/rocks below).
    let mut kept = 0;
    for group in &mut groups {
        for instance in &mut group.instances {
            if instance.conf >= 0.5 {
                instance.decision = Decision::Keep;
                kept += 1;
            }
        }
    }
    assert_eq!(kept, 3, "exactly the 3 cam_A birds are the reals to keep");

    let refs = removals(&groups);
    assert_eq!(refs.len(), 44, "47 suspicious - 3 kept = 44 removed (GROUND_TRUTH)");

    let before = doc.total_detections();
    let filtered = apply_removals(&doc, &refs);
    assert_eq!(before - filtered.total_detections(), 44);
}

#[test]
fn export_preserves_unknown_and_future_fields() {
    // Mask-on-original must preserve fields rde-core does not model (SPEC §2.5).
    let json = br#"{
      "info": { "format_version": "1.5", "custom_x": "keepme" },
      "detection_categories": { "1": "animal" },
      "future_top_level": [1, 2, 3],
      "images": [
        { "file": "/d/cam/a.jpg", "weird_field": "survive", "detections": [
            { "category": "1", "conf": 0.9, "bbox": [0.0, 0.0, 0.1, 0.1], "extra": "note" }
        ] }
      ]
    }"#;
    let doc = MdDocument::from_slice(json).unwrap();
    let out = apply_removals(&doc, &[DetRef { image_index: 0, detection_index: 0 }]);
    let v = out.value();

    assert_eq!(v["info"]["custom_x"], "keepme");
    assert_eq!(v["future_top_level"], serde_json::json!([1, 2, 3]));
    assert_eq!(v["images"][0]["weird_field"], "survive");
    assert_eq!(
        v["images"][0]["detections"].as_array().unwrap().len(),
        0,
        "the one detection was removed"
    );
}

#[test]
fn passthrough_export_is_identical() {
    // No removals => byte-identical document (order preserved by preserve_order).
    let doc = demo();
    let out = apply_removals(&doc, &[]);
    assert_eq!(out.value(), doc.value());
    assert_eq!(out.to_json_vec(), doc.to_json_vec());
}

fn near(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.02)
}

/// `occurrence_threshold` is only ever a *final filter* — it never influences how
/// detections are clustered. That is what lets the reviewer scrub the threshold
/// with no re-clustering: cluster once at 2, then filter on `media_count`.
/// If this ever stops holding, the tuning view silently shows the wrong groups.
#[test]
fn threshold_is_only_a_final_filter() {
    let doc = demo();
    let all = find_suspicious(
        &doc,
        &RdeOptions { occurrence_threshold: 2, ..RdeOptions::default() },
    );

    for threshold in [2, 3, 5, 10, 20, 25, 40] {
        let direct = find_suspicious(
            &doc,
            &RdeOptions { occurrence_threshold: threshold, ..RdeOptions::default() },
        );
        let filtered: Vec<_> = all.iter().filter(|g| g.media_count >= threshold).collect();

        assert_eq!(direct.len(), filtered.len(), "group count at threshold {threshold}");
        for (a, b) in direct.iter().zip(&filtered) {
            assert_eq!(a.camera, b.camera, "camera at threshold {threshold}");
            assert_eq!(a.rep_bbox, b.rep_bbox, "rep box at threshold {threshold}");
            assert_eq!(a.media_count, b.media_count, "media_count at threshold {threshold}");
            assert_eq!(
                a.instances.len(),
                b.instances.len(),
                "instance count at threshold {threshold}"
            );
        }
    }
}

/// `media_count` is distinct media, not instance count — several detections on
/// one image (or several frames of one clip) are one occurrence.
#[test]
fn media_count_counts_distinct_media() {
    use std::collections::HashSet;
    let doc = demo();
    for group in find_suspicious(&doc, &RdeOptions::default()) {
        let distinct: HashSet<usize> =
            group.instances.iter().map(|i| i.det_ref.image_index).collect();
        assert_eq!(group.media_count, distinct.len(), "group {}", group.id);
        assert!(group.media_count <= group.instances.len());
    }
}
