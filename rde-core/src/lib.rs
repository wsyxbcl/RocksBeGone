//! Caracal RDE core — the repeat-detection-elimination algorithm, independent of
//! browser/media I/O so it runs in WASM or natively (and is tested natively).
//!
//! It reproduces the reference `find` step in
//! `MegaDetector/rde-lab/demo/verify_rde.py` (SPEC §3): per camera, cluster
//! candidate detections by IoU and flag any location group that recurs across at
//! least `occurrence_threshold` distinct images.
//!
//! The original MegaDetector document is held complete and immutable (SPEC §6.1);
//! export applies a removal mask to *that* document (§6.3) so unknown/future/video
//! fields survive untouched — it never rebuilds the document from the projection.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

pub mod path;
pub use path::{match_paths, PathMatch};

/// Normalized bounding box `[x, y, w, h]`, origin top-left, each in `[0, 1]`.
pub type BBox = [f32; 4];

/// Upstream `RepeatDetectionOptions` (SPEC §3 defaults).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RdeOptions {
    /// Confidence band considered (inclusive).
    pub confidence_min: f32,
    pub confidence_max: f32,
    /// Distinct **media** a location must recur across before it is suspicious.
    ///
    /// **This deliberately differs from upstream.** MegaDetector compares
    /// `occurrenceThreshold` against `len(candidate_location.instances)` — every
    /// detection, so a single clip with 30 detected frames counts as 30. We count
    /// the clip once, because a rock seen in one clip is one observation, not
    /// thirty. For still-only datasets the two agree; for video ours is much
    /// stricter, so upstream's 20 and ours are not the same number.
    pub occurrence_threshold: usize,
    /// How identical two boxes must be to count as the same location.
    ///
    /// Upstream ships 0.9 and notes why slack is needed: rocks do not move but
    /// cameras do, and branches do. Under group-first review looser matching is
    /// close to free — it mostly makes existing groups bigger rather than making
    /// new ones (as: 0.90 -> 0.80 is +7% groups for +40% detections; on diq it
    /// *reduces* group count) — so 0.8 buys recall the occurrence threshold
    /// cannot buy as cheaply.
    pub iou_threshold: f32,
    /// Ignore boxes whose area (w·h) is outside this band.
    pub min_suspicious_size: f32,
    pub max_suspicious_size: f32,
    /// Which folder level (from the leaf) identifies one camera.
    pub n_dir_levels_from_leaf: usize,
    /// Compare boxes across detection categories, or keep categories separate.
    pub category_agnostic: bool,
}

impl Default for RdeOptions {
    fn default() -> Self {
        Self {
            confidence_min: 0.1,
            confidence_max: 1.0,
            // Back to upstream's 20, after the review model changed under it.
            // Lowering it to 10 was argued from CANDIDATE counts, which is the
            // cost of reviewing every crop. Review is now group-first — one
            // handful of exemplars per group — so the human cost is the number of
            // GROUPS, and by that measure 10 more than doubles the work
            // (as: 309 -> 697 groups) to catch 28% more detections. Loosening IoU
            // buys the same recall far cheaper: +13% groups for +53% detections.
            occurrence_threshold: 20,
            iou_threshold: 0.8,
            min_suspicious_size: 0.0,
            max_suspicious_size: 0.2,
            n_dir_levels_from_leaf: 0,
            category_agnostic: false,
        }
    }
}

/// Stable coordinates of one detection inside the original MD document:
/// `images[image_index].detections[detection_index]`. Invariant across
/// re-clustering, so a saved review round-trips against the same document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DetRef {
    pub image_index: usize,
    pub detection_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Decision {
    /// A suspicious instance is a removal candidate by default (SPEC §4/§6.1).
    #[default]
    Remove,
    Keep,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instance {
    pub det_ref: DetRef,
    pub bbox: BBox,
    pub conf: f32,
    pub decision: Decision,
    /// For a detection on a video frame (SPEC §2.2), the 0-based
    /// presentation-order frame index from the start of the clip — ffmpeg's `n`,
    /// which is what our `run_md_video.py` selects on. `None` for stills, so the
    /// pixel provider knows which media need a frame decode (SPEC §7).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_number: Option<u32>,
}

/// One detection as the review UI needs it — every box on a media, not just the
/// suspicious ones (see `MdDocument::detections_of`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DetectionView {
    pub detection_index: usize,
    pub bbox: BBox,
    pub conf: f32,
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_number: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupStats {
    pub count: usize,
    pub conf_min: f32,
    pub conf_median: f32,
    pub conf_max: f32,
}

/// A cluster of near-identical boxes from one camera that recurs often enough to
/// be suspicious. Instances default to `Remove`; review flips reals to `Keep`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuspiciousGroup {
    pub id: usize,
    pub camera: String,
    /// The category of this group. Under `category_agnostic` this is the
    /// representative instance's category (instances may then differ).
    pub category: String,
    pub rep_bbox: BBox,
    pub instances: Vec<Instance>,
    pub stats: GroupStats,
    /// Distinct media this location recurs across — the quantity
    /// `occurrence_threshold` is compared against. Carried on the group so a
    /// caller can re-apply a *higher* threshold without re-clustering: the
    /// threshold is only ever a final filter, never an input to clustering.
    pub media_count: usize,
}

/// Errors from parsing an MD document.
#[derive(Debug)]
pub enum RdeError {
    Json(serde_json::Error),
    Schema(String),
}

impl std::fmt::Display for RdeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RdeError::Json(error) => write!(f, "invalid MegaDetector json: {error}"),
            RdeError::Schema(message) => write!(f, "unexpected MegaDetector json: {message}"),
        }
    }
}

impl std::error::Error for RdeError {}

impl From<serde_json::Error> for RdeError {
    fn from(error: serde_json::Error) -> Self {
        RdeError::Json(error)
    }
}

/// The parsed MegaDetector document, kept complete and immutable (SPEC §6.1).
/// Backed by `serde_json::Value` with `preserve_order`, so an export preserves
/// unknown/future/video fields and their order.
#[derive(Debug, Clone)]
pub struct MdDocument {
    root: serde_json::Value,
}

impl MdDocument {
    /// Parse raw bytes (e.g. a `File` `ArrayBuffer`, avoiding a JS-string copy).
    pub fn from_slice(bytes: &[u8]) -> Result<Self, RdeError> {
        let root: serde_json::Value = serde_json::from_slice(bytes)?;
        if !root.get("images").map(|v| v.is_array()).unwrap_or(false) {
            return Err(RdeError::Schema("missing top-level 'images' array".into()));
        }
        Ok(Self { root })
    }

    pub fn images(&self) -> &[serde_json::Value] {
        self.root
            .get("images")
            .and_then(|v| v.as_array())
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Total detections across all images (for export accounting).
    pub fn total_detections(&self) -> usize {
        self.images()
            .iter()
            .filter_map(|image| image.get("detections").and_then(|d| d.as_array()))
            .map(|d| d.len())
            .sum()
    }

    /// `(image_index, frame_rate)` for every video entry (SPEC §2.2). Sparse on
    /// purpose — only a minority of media are video, and the pixel provider needs
    /// the rate only to sanity-check the frame index it seeks to (SPEC §7).
    pub fn video_frame_rates(&self) -> Vec<(usize, f64)> {
        self.images()
            .iter()
            .enumerate()
            .filter_map(|(index, image)| {
                let rate = image.get("frame_rate").and_then(|v| v.as_f64())?;
                (rate > 0.0).then_some((index, rate))
            })
            .collect()
    }

    /// Every detection on one media, suspicious or not, so a review can show what
    /// else the detector found there. A suspicious box that overlaps a real animal
    /// is the case a reviewer most needs context for, and clustering alone never
    /// surfaces the animal — it is in no group.
    pub fn detections_of(&self, image_index: usize) -> Vec<DetectionView> {
        let Some(image) = self.images().get(image_index) else {
            return Vec::new();
        };
        let Some(detections) = image.get("detections").and_then(|d| d.as_array()) else {
            return Vec::new();
        };
        detections
            .iter()
            .enumerate()
            .filter_map(|(detection_index, det)| {
                Some(DetectionView {
                    detection_index,
                    bbox: parse_bbox(det)?,
                    conf: det.get("conf").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
                    category: det
                        .get("category")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    frame_number: det
                        .get("frame_number")
                        .and_then(|v| v.as_u64())
                        .map(|n| n as u32),
                })
            })
            .collect()
    }

    /// The document's `detection_categories` (`"1" -> "animal"`), for labelling.
    pub fn category_names(&self) -> BTreeMap<String, String> {
        self.root
            .get("detection_categories")
            .and_then(|v| v.as_object())
            .map(|map| {
                map.iter()
                    .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The underlying document (read-only).
    pub fn value(&self) -> &serde_json::Value {
        &self.root
    }

    pub fn to_json_vec(&self) -> Vec<u8> {
        serde_json::to_vec(&self.root).expect("Value re-serializes")
    }

    pub fn to_json_pretty(&self) -> String {
        serde_json::to_string_pretty(&self.root).expect("Value re-serializes")
    }
}

/// Camera = the folder `2 + n_dir_levels_from_leaf` components from the end of
/// the path (matches `verify_rde.py::camera_of` and our `camera_site_from_path`).
fn camera_of(path: &str, n_dir_levels_from_leaf: usize) -> &str {
    // Splitting on both separators is equivalent to normalizing '\' -> '/' first.
    let parts: Vec<&str> = path.split(['/', '\\']).collect();
    let want = 2 + n_dir_levels_from_leaf;
    if parts.len() >= want {
        parts[parts.len() - want]
    } else {
        // Path too shallow for that folder level; fall back to the leftmost part.
        parts.first().copied().unwrap_or("")
    }
}

/// Intersection-over-union of two normalized `[x, y, w, h]` boxes.
fn iou(a: &BBox, b: &BBox) -> f32 {
    let ix0 = a[0].max(b[0]);
    let iy0 = a[1].max(b[1]);
    let ix1 = (a[0] + a[2]).min(b[0] + b[2]);
    let iy1 = (a[1] + a[3]).min(b[1] + b[3]);
    let iw = (ix1 - ix0).max(0.0);
    let ih = (iy1 - iy0).max(0.0);
    let inter = iw * ih;
    let union = a[2] * a[3] + b[2] * b[3] - inter;
    if union > 0.0 {
        inter / union
    } else {
        0.0
    }
}

fn parse_bbox(det: &serde_json::Value) -> Option<BBox> {
    let arr = det.get("bbox")?.as_array()?;
    if arr.len() != 4 {
        return None;
    }
    let mut bbox = [0.0f32; 4];
    for (i, value) in arr.iter().enumerate() {
        bbox[i] = value.as_f64()? as f32;
    }
    Some(bbox)
}

fn group_stats(members: &[Instance]) -> GroupStats {
    let mut confs: Vec<f32> = members.iter().map(|m| m.conf).collect();
    confs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let count = confs.len();
    let conf_min = confs.first().copied().unwrap_or(0.0);
    let conf_max = confs.last().copied().unwrap_or(0.0);
    let conf_median = if count == 0 {
        0.0
    } else if count % 2 == 1 {
        confs[count / 2]
    } else {
        (confs[count / 2 - 1] + confs[count / 2]) / 2.0
    };
    GroupStats {
        count,
        conf_min,
        conf_median,
        conf_max,
    }
}

// A growing cluster during the find pass. `rep` is fixed to the first member's
// box (matching the reference), so cluster membership is order-stable.
struct Cluster {
    camera: String,
    category: String,
    rep: BBox,
    members: Vec<Instance>,
    images: HashSet<usize>,
}

/// Find suspicious detection groups (SPEC §3). Detections from different cameras
/// are never compared; unless `category_agnostic`, neither are different
/// categories. Groups are returned in a deterministic order with assigned ids.
pub fn find_suspicious(doc: &MdDocument, opts: &RdeOptions) -> Vec<SuspiciousGroup> {
    let mut clusters: Vec<Cluster> = Vec::new();
    // Candidates can only ever join a cluster from the same camera (and, unless
    // agnostic, the same category), so scanning every cluster means comparing
    // strings that cannot match: 72 cameras here, i.e. ~23/24 of the work wasted.
    // Bucket cluster indices by that key instead. Indices stay in insertion order
    // within a bucket, and a match is only possible inside one bucket, so the
    // first hit is still the first hit globally — the greedy semantics are
    // unchanged (`reproduces_reference_find` pins that).
    let mut buckets: HashMap<(&str, &str), Vec<usize>> = HashMap::new();

    for (image_index, image) in doc.images().iter().enumerate() {
        // Decode failures carry no RDE-relevant boxes.
        if image.get("failure").is_some() {
            continue;
        }
        let file = image.get("file").and_then(|v| v.as_str()).unwrap_or("");
        let camera = camera_of(file, opts.n_dir_levels_from_leaf);
        let Some(detections) = image.get("detections").and_then(|v| v.as_array()) else {
            continue;
        };

        for (detection_index, det) in detections.iter().enumerate() {
            let Some(bbox) = parse_bbox(det) else {
                continue;
            };
            let conf = det.get("conf").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            let area = bbox[2] * bbox[3];
            if conf < opts.confidence_min || conf > opts.confidence_max {
                continue;
            }
            if area < opts.min_suspicious_size || area > opts.max_suspicious_size {
                continue;
            }
            let category = det.get("category").and_then(|v| v.as_str()).unwrap_or("");

            let instance = Instance {
                det_ref: DetRef {
                    image_index,
                    detection_index,
                },
                bbox,
                conf,
                decision: Decision::default(),
                frame_number: det
                    .get("frame_number")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32),
            };

            // Greedy: the first cluster in this bucket whose fixed representative
            // overlaps enough. Find the index first, then move `instance` once.
            let bucket = buckets
                .entry((camera, if opts.category_agnostic { "" } else { category }))
                .or_default();
            let target = bucket
                .iter()
                .copied()
                .find(|&index| iou(&bbox, &clusters[index].rep) >= opts.iou_threshold);
            match target {
                Some(index) => {
                    clusters[index].images.insert(image_index);
                    clusters[index].members.push(instance);
                }
                None => {
                    bucket.push(clusters.len());
                    clusters.push(Cluster {
                        camera: camera.to_string(),
                        category: category.to_string(),
                        rep: bbox,
                        images: HashSet::from([image_index]),
                        members: vec![instance],
                    });
                }
            }
        }
    }

    let mut groups: Vec<SuspiciousGroup> = clusters
        .into_iter()
        .filter(|cluster| cluster.images.len() >= opts.occurrence_threshold)
        .map(|cluster| SuspiciousGroup {
            id: 0,
            camera: cluster.camera,
            category: cluster.category,
            rep_bbox: cluster.rep,
            stats: group_stats(&cluster.members),
            media_count: cluster.images.len(),
            instances: cluster.members,
        })
        .collect();

    // Stable order (camera, category, rep position) then assign ids.
    groups.sort_by(|a, b| {
        a.camera
            .cmp(&b.camera)
            .then_with(|| a.category.cmp(&b.category))
            .then_with(|| cmp_f32(a.rep_bbox[0], b.rep_bbox[0]))
            .then_with(|| cmp_f32(a.rep_bbox[1], b.rep_bbox[1]))
    });
    for (index, group) in groups.iter_mut().enumerate() {
        group.id = index;
    }
    groups
}

fn cmp_f32(a: f32, b: f32) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// The `DetRef`s of every instance currently marked `Remove` (SPEC §6.3).
pub fn removals(groups: &[SuspiciousGroup]) -> Vec<DetRef> {
    groups
        .iter()
        .flat_map(|group| group.instances.iter())
        .filter(|instance| instance.decision == Decision::Remove)
        .map(|instance| instance.det_ref)
        .collect()
}

/// Apply a removal mask to the original document (SPEC §6.3): a copy with the
/// listed detections dropped and every other field preserved. Removal is by
/// original index (no index-shift), so passing multiple refs per image is safe.
pub fn apply_removals(doc: &MdDocument, refs: &[DetRef]) -> MdDocument {
    let mut per_image: HashMap<usize, HashSet<usize>> = HashMap::new();
    for det_ref in refs {
        per_image
            .entry(det_ref.image_index)
            .or_default()
            .insert(det_ref.detection_index);
    }

    let mut root = doc.root.clone();
    if let Some(images) = root.get_mut("images").and_then(|v| v.as_array_mut()) {
        for (image_index, image) in images.iter_mut().enumerate() {
            let Some(remove) = per_image.get(&image_index) else {
                continue;
            };
            if let Some(detections) = image.get_mut("detections").and_then(|v| v.as_array_mut()) {
                let mut index = 0usize;
                detections.retain(|_| {
                    let keep = !remove.contains(&index);
                    index += 1;
                    keep
                });
            }
        }
    }
    MdDocument { root }
}
