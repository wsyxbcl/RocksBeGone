//! Video plumbing (SPEC §2.2/§7): a detection on a video frame carries the
//! `frame_number` the pixel provider must decode, and the clip's `frame_rate` is
//! recoverable per media. Stills carry neither.

use rde_core::{find_suspicious, MdDocument, RdeOptions};

const VIDEO_DEMO: &[u8] = include_bytes!("fixtures/video_demo.json");

fn doc() -> MdDocument {
    MdDocument::from_slice(VIDEO_DEMO).expect("parse video fixture")
}

#[test]
fn video_instances_carry_frame_numbers() {
    let doc = doc();
    let groups = find_suspicious(&doc, &RdeOptions::default());

    // The static twig box recurs across 22 distinct videos — one suspicious
    // group. NB: the 7 frames *inside* one video are one occurrence, not seven:
    // clustering counts distinct media (`image_index`).
    assert_eq!(groups.len(), 1, "expected one suspicious group");
    let group = &groups[0];
    assert_eq!(group.camera, "cam_V");
    assert_eq!(group.instances.len(), 22 * 7, "22 videos x 7 flagged frames");

    // Every instance knows which frame to decode.
    assert!(
        group.instances.iter().all(|i| i.frame_number.is_some()),
        "every video instance needs a frame_number"
    );

    // Per video, the flagged frames are exactly the ones the workflow processed.
    let first = group.instances[0].det_ref.image_index;
    let mut frames: Vec<u32> = group
        .instances
        .iter()
        .filter(|i| i.det_ref.image_index == first)
        .filter_map(|i| i.frame_number)
        .collect();
    frames.sort_unstable();
    assert_eq!(frames, vec![0, 1, 2, 150, 151, 152, 300]);
}

#[test]
fn frame_rates_are_recoverable_for_videos_only() {
    let rates = doc().video_frame_rates();

    // 22 flagged videos + 1 propagated video, but not the still.
    assert_eq!(rates.len(), 23, "only video entries carry a frame_rate");
    assert!(rates.iter().all(|(_, rate)| *rate == 30.0));

    // Indices are image_index into the original document, so the pixel provider
    // can join them to the paths from `image_files` (SPEC §6.2).
    let images = doc();
    for (index, _) in rates {
        let file = images.images()[index]["file"].as_str().unwrap();
        assert!(file.ends_with(".mp4"), "{file} should be a video");
    }
}

#[test]
fn stills_have_no_frame_number() {
    // The lone still is its own camera and never clusters, so reach for it
    // directly: a still's detections must not fabricate a frame index.
    let doc = doc();
    let still = doc
        .images()
        .iter()
        .find(|image| image["file"].as_str().unwrap().ends_with(".jpg"))
        .expect("the fixture has one still");
    assert!(still.get("frame_rate").is_none());
    assert!(still["detections"][0].get("frame_number").is_none());
}

#[test]
fn propagated_video_contributes_no_instances() {
    // SPEC §2.2: a propagated/skipped video has frames_processed but no per-frame
    // detections — it must not appear in any group.
    let doc = doc();
    let groups = find_suspicious(&doc, &RdeOptions::default());
    let propagated = doc
        .images()
        .iter()
        .position(|image| image["file"].as_str().unwrap().ends_with("VID_0099.mp4"))
        .expect("the fixture has a propagated video");
    assert!(!groups
        .iter()
        .flat_map(|g| &g.instances)
        .any(|i| i.det_ref.image_index == propagated));
}
