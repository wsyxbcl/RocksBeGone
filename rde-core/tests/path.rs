//! Ambiguity-safe path matching (SPEC §6.2), including the demo's headline case:
//! the same basename under multiple camera folders must resolve by folder, and
//! only when the resolution is unique.

use rde_core::{match_paths, PathMatch};

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[test]
fn shared_basename_resolves_by_folder() {
    // json has absolute paths; the picked folder yields paths rooted at `images/`.
    let json = s(&[
        "/home/u/demo/images/cam_A/frame_0001.jpg",
        "/home/u/demo/images/cam_B/frame_0001.jpg",
        "/home/u/demo/images/cam_exif/frame_0001.jpg",
    ]);
    let picked = s(&[
        "images/cam_exif/frame_0001.jpg",
        "images/cam_A/frame_0001.jpg",
        "images/cam_B/frame_0001.jpg",
    ]);
    let matches = match_paths(&json, &picked);
    assert_eq!(matches[0], PathMatch::Matched { picked_index: 1 }); // cam_A
    assert_eq!(matches[1], PathMatch::Matched { picked_index: 2 }); // cam_B
    assert_eq!(matches[2], PathMatch::Matched { picked_index: 0 }); // cam_exif
}

#[test]
fn windows_separators_normalize() {
    let json = s(&["D:\\data\\cam_A\\IMG_0001.JPG"]);
    let picked = s(&["cam_A/IMG_0001.JPG"]);
    assert_eq!(match_paths(&json, &picked)[0], PathMatch::Matched { picked_index: 0 });
}

#[test]
fn missing_basename_is_unmatched() {
    let json = s(&["/x/cam/only_in_json.jpg"]);
    let picked = s(&["cam/other.jpg"]);
    assert_eq!(match_paths(&json, &picked)[0], PathMatch::Unmatched);
}

#[test]
fn indistinguishable_suffix_is_ambiguous_not_guessed() {
    // Two picked files with the identical suffix the json can offer -> never guess.
    let json = s(&["a/cam/IMG_0001.JPG"]);
    let picked = s(&["one/cam/IMG_0001.JPG", "two/cam/IMG_0001.JPG"]);
    assert_eq!(match_paths(&json, &picked)[0], PathMatch::Ambiguous);
}

#[test]
fn unique_basename_matches_even_with_short_json_path() {
    // Basename fallback (SPEC §6.2 step 4) when it is unique among picked files.
    let json = s(&["IMG_0042.JPG"]);
    let picked = s(&["deep/nested/cam/IMG_0042.JPG", "deep/nested/cam/IMG_0043.JPG"]);
    assert_eq!(match_paths(&json, &picked)[0], PathMatch::Matched { picked_index: 0 });
}
