# RocksBeGone — development spec

> **This is the design record, not the manual.** It was written before the tool
> existed, while it was still a route inside [Caracal](https://caracal.hinature.cn)
> — hence the references to that app, and to phases that have since happened.
> Kept because the code cites its section numbers, and because the reasoning
> behind the divergences from upstream is here and nowhere else.
>
> Where it is now out of date: video (§7) and the local binary shipped, so
> "deferred" and "Phase 1 — images only" no longer hold; the tool was split into
> this standalone repo rather than staying a Caracal route (§10, first question);
> `occurrence` counts distinct media and the IoU default is 0.8 (§3, and the
> README). Time-based criteria (§8) really are still unbuilt.

A **client-side repeat-detection-elimination (RDE) reviewer**, delivered the way Caracal already
delivers: one WASM bundle, served online as a static site *or* offline by a local binary, with
**all compute client-side and no data leaving the browser**. It reads a MegaDetector (MD) results
`.json`, finds "suspicious" repeated detections, lets a human review them efficiently in an
interactive interface, and exports a filtered `.json`.

- **Relationship to Caracal:** a new, mostly **independent interface** in the same app — reuses the
  build/deploy pipeline, the local-data model, and `charton` for stats. Caracal (CSV timestamps →
  activity charts) and this (MD json → detection review) share infra and the Serval ecosystem, not
  UI.
- **Phase 1 scope: images only.** Video is designed-for but deferred (§7).
- **Upstream intent:** this is Morris's TODO "client-side RDE tool" (P2/E3). Build against our
  workflow's `combined_md.json` first, then generalize to a vanilla MD `.json`.

---

## 0. Reference sources

Upstream MegaDetector, which this ports and must stay comparable to:

- [`repeat_detections_core.py`](https://github.com/agentmorris/MegaDetector/blob/main/megadetector/postprocessing/repeat_detection_elimination/repeat_detections_core.py)
  — `RepeatDetectionOptions` defaults, the clustering, the `detectionIndex.json` handoff.
- [`find_repeat_detections.py`](https://github.com/agentmorris/MegaDetector/blob/main/megadetector/postprocessing/repeat_detection_elimination/find_repeat_detections.py)
  and [`remove_repeat_detections.py`](https://github.com/agentmorris/MegaDetector/blob/main/megadetector/postprocessing/repeat_detection_elimination/remove_repeat_detections.py)
- [`process_video.py`](https://github.com/agentmorris/MegaDetector/blob/main/megadetector/detection/process_video.py)
  — where the video fields this tool reads (`frame_rate`, `frames_processed`,
  `frame_number`) come from.
- [The process, and when it misleads](https://lila.science/repeat-detection-elimination).

## 1. What "RDE" is (the problem)

Camera traps shoot thousands of frames from a fixed viewpoint. If the detector calls a branch/rock
an "animal" once, it usually calls **the same box** an animal in hundreds of images. If *exactly the
same bounding box* recurs across many images from one camera, that box is a **suspicious
detection** — very likely a fixed false positive. RDE:

1. **Find** suspicious detections (repeated boxes) per camera.
2. **Review** — a human confirms which are truly false positives vs real (a sleeping animal, or
   people repeatedly entering at the same spot, also produce repeated boxes).
3. **Apply** — remove the confirmed false positives from the results.

This can delete tens of thousands of false detections with minutes of review.

**New capability (Morris explicitly wants this, we want it too):** today review is *all-or-nothing
per group* — if a group is 1 real animal + 100 FPs you keep all 101. The new tool supports
**per-instance decisions**: keep the 1, drop the 100.

---

## 2. Data — how it looks

> **Demo dataset.** `rde-core/tests/fixtures/mdv1000_demo.json` is the results
> file the native tests run against: 54 frames, engineered to contain exactly two
> suspicious groups including the per-instance-keep case (cam_A: keep 3 of 25;
> cam_B: remove all 22; deer, persons and blanks not flagged). The matching
> images, the generator and a dependency-free reference implementation of §3 live
> outside this repo with the MegaDetector working copy they were built beside —
> the fixture is committed because the tests need it, the imagery is not because
> nothing here reads it.
>
> `rde-core/tests/fixtures/video_demo.json` is the equivalent for §7: video
> entries with `frame_rate`, `frames_processed` and per-detection `frame_number`.

### 2.1 Input: MegaDetector results `.json`

Standard MD "batch results", `format_version` 1.x. Top level:

```json
{
  "info": { "format_version": "1.5", "detector": "mdv1000-redwood", "...": "..." },
  "detection_categories": { "1": "animal", "2": "person", "3": "vehicle" },
  "images": [ /* one entry per media item */ ]
}
```

**Image entry:**
```json
{
  "file": "/abs/or/rel/path/cam03/IMG_0002.jpg",
  "detections": [
    { "category": "2", "conf": 0.967, "bbox": [0.0, 0.0, 0.8519, 0.9921] }
  ]
}
```

- `category` is a **string key** into `detection_categories`. RDE is usually run on `"1"` (animal),
  but is category-aware (option to compare across categories or not).
- `conf` ∈ [0,1].
- **`bbox` = `[x_min, y_min, width, height]`, all normalized to [0,1], origin top-left.** This is the
  only geometry the tool needs. Absolute pixels = bbox × (image width/height), needed only at
  render time.
- `detections` may be `[]` (no detection) — irrelevant to RDE.
- An entry may carry `"failure": "..."` (decode error) instead of detections — skip for RDE.

**Size scope (P1).** P1 uses **normal in-memory parsing** and targets ordinary MD result sizes.
Note the peak-memory multiplier of the naive path (`File → JS string → WASM copy → serde_json
structures → serialized output` — several full copies co-resident); a mitigation is to hand the
`File`'s `ArrayBuffer` straight into WASM and parse bytes, skipping the JS-string copy. Either way,
**multi-GB input is out of scope for P1**: the tool must **fail clearly** when a dataset exceeds
practical browser/WASM memory limits, not silently thrash. Streaming/indexed parsing is a future
optimization, to be built only if real datasets demand it — *not* a reason to add a native-compute
path.

### 2.2 Input (our workflow extension): video entries

Our `run_md_video.py` / `combined_md.json` add video items in the **same `images` array**:

```json
{
  "file": "/.../cam03/IMG_0001.mp4",
  "frame_rate": 40.0,
  "frames_processed": [0, 1, 2, 7, 9, 120, 240, 318, "..."],
  "detections": [
    { "category": "2", "conf": 0.983, "bbox": [0.6813, 0.0056, 0.3186, 0.9521], "frame_number": 0 },
    { "category": "2", "conf": 0.981, "bbox": [0.6809, 0.0056, 0.319,  0.9511], "frame_number": 1 }
  ]
}
```

- Distinguisher: `frames_processed` present, and detections carry **`frame_number`**.
- A propagated/skipped video (inference reused from a sibling photo) has `frames_processed` but no
  per-frame detections — treat as no RDE-relevant boxes.
- Vanilla upstream MD video output (`process_video.py`) is structurally similar (per-frame
  detections with a frame index); Phase-1 images can ignore this entirely.

### 2.3 Input: the image files

The pixels are **local**. Folder loading is a pluggable **input adapter**; there are two, and they
are **not** the same mechanism:
- **P1 (required): directory picker** — `<input type="file" webkitdirectory>` → a `File[]` where
  each file carries `webkitRelativePath`. Read-only, works in current major desktop browsers. This
  is the *only* folder path P1 needs to implement.
- **Later (optional): folder drag-and-drop** — a *different* traversal (`DataTransferItem`
  `webkitGetAsEntry()` / `FileSystemEntry`), so it is a separate adapter, not a drop-in equivalent.
  Deferred.

Only the *suspicious* images are ever decoded (§5).

### 2.4 Input (optional, for §8 time criteria): timestamps

MD json has **no timestamps**. Time comes from EXIF, the filename, or a sidecar CSV — which is
exactly what Caracal already ingests. Phase-1 doesn't need it; the data model reserves a slot.

### 2.5 Output: filtered MD `.json`

**Export is a mask applied to the *original* parsed MD document, never a rebuild from `rde-core`'s
model** (see §6 — this is a core-contract requirement, not an implementation detail). The output is
byte-for-byte the input with confirmed-FP detections removed/marked (§6.3), so it **preserves**:
unknown MD fields, `info`/`detector_metadata`, our workflow extensions (`frame_rate`,
`frames_processed`, `failure`, `frame_number`), and any future schema additions. Delivered as a
**Blob download** — no folder write, so no File System Access API. Optionally also emit a small
**review-session json** (the decisions, keyed by the stable `(image_index, detection_index)` refs of
§6.1) so a review can be re-opened / audited (this replaces upstream's `detectionIndex.json` +
folder-of-images handoff).

---

## 3. The RDE algorithm (find)

Per **camera** (detections from different cameras are never compared):

1. **Group by camera.** Camera = a folder in the path. Controlled by `nDirLevelsFromLeaf`
   (0 = the leaf folder is the camera; N = go N levels up). Our workflow derives it the same way
   (`camera_site_from_path`). For video virtual frames the camera is taken from the *video's* path.
2. **Filter candidate detections:** keep only those with
   `confidenceMin ≤ conf ≤ confidenceMax`, category not excluded, and box **area** in
   `[minSuspiciousDetectionSize, maxSuspiciousDetectionSize]` (area = w×h, normalized).
3. **Cluster by location:** two detections are "the same location" if `IoU ≥ iouThreshold`. Group
   all mutually-overlapping candidate boxes. (Upstream uses an r-tree for speed; Rust: `rstar`.)
4. **Flag suspicious:** a location group present in **≥ `occurrenceThreshold` distinct images/frames**
   is a *suspicious detection*.
5. Emit, per camera, the list of suspicious groups; each group carries its member **instances**
   (image/frame + bbox + conf).

### Default parameters (upstream `RepeatDetectionOptions`)

| param | default | meaning |
|---|---|---|
| `confidenceMin` / `confidenceMax` | 0.1 / 1.0 | confidence band considered |
| `occurrenceThreshold` | 20 | repeats before a box is "suspicious" |
| `iouThreshold` | 0.9 | how identical two boxes must be to be "the same" |
| `minSuspiciousDetectionSize` | 0.0 | ignore boxes smaller than this (area fraction) |
| `maxSuspiciousDetectionSize` | 0.2 | ignore boxes larger than this (big boxes ≈ real animals) |
| `nDirLevelsFromLeaf` | 0 | which folder level counts as one camera |
| `categoryAgnosticComparisons` | false | compare boxes across categories? |
| *(new, §8)* `timeSpread*` | — | temporal criterion |

All are **live** in the UI (requirement: user tweaks params and re-clusters instantly — cheap, pure
WASM, no image work needed).

---

## 4. The interactive RDE workflow (this tool)

The classic pipeline is three stitched tools (python `find` → third-party image viewer → Windows
explorer to delete → python `remove`). We collapse it into one loop:

```
 load MD json ─┐
 pick folder  ─┴─▶ [WASM] cluster suspicious ──▶ [browser] render box-crop tiles per group
                                   ▲                         │
                       tweak params│                         ▼
                    (re-cluster, instant)          human marks per-instance / per-group:
                                   │                    keep (real) vs remove (FP)
                       [charton] stats ◀────────── decisions update state
                                                             │
                                                             ▼
                                              [WASM] build filtered json ──▶ download
```

Review UX, per suspicious group:
- Show a **sample** (the box drawn on one representative image) + a **grid of individual crop
  tiles**, one per instance. **Not** a baked mosaic — individual tiles so each is clickable.
- Default state of a suspicious group = "remove all instances" (they're FP candidates).
- Human actions: **rescue whole group** (it's a real animal → keep all), or **rescue individual
  tiles** (per-instance keep), or leave as remove.
- Efficiency: crops are tiny and lazy-rendered; a reviewer scans a grid and clicks the few reals.

---

## 5. Architecture — the WASM / browser split

Consistent with Caracal: compute in WASM, pixels in the browser.

| Concern | Runs in | Notes |
|---|---|---|
| Parse MD json | **WASM** (serde_json) | P1: normal in-memory (§2.1 limits) |
| Cluster suspicious (§3) | **WASM** (rstar, geometry) | instant re-run on param change |
| Stats / distributions | **WASM** → **charton** | reuse Caracal's charting |
| Build filtered json (mask on original) | **WASM** | per-instance apply (§6.3) |
| Folder load + path match | **browser JS** | directory picker (§2.3), §6.2 |
| Decode image | **browser** (`createImageBitmap`) | native codec — *not* WASM pixel-work; **apply EXIF orientation** (see below) |
| Decode video frame (§7) | **browser** (WebCodecs + demuxer) | client-side; feature-detect at runtime |
| Draw box + crop → tile | **browser** (canvas/OffscreenCanvas) | cheap raster |
| Download output | **browser** (Blob) | no folder write |

**Rule:** WASM never decodes pixels. The browser decodes with its native codec; WASM only ever sees
geometry and metadata. This is what makes the "decode is expensive in WASM" problem a non-issue.

**EXIF orientation (correctness).** MegaDetector's `open_image` applies EXIF orientation by default
(rotates pixels per tag 274, `expand=True`), so **MD bboxes are in the EXIF-upright coordinate
space**. The browser must therefore decode with orientation *applied* — `createImageBitmap(blob,
{ imageOrientation: 'from-image' })` (the modern default) — so bbox and pixels share a frame. A JPEG
with a non-default orientation tag is a required P1 regression asset (§9).

Factor the algorithmic logic as a reusable Rust crate (`rde-core`), **independent of browser/media
I/O**, so it can also compile natively if another native consumer is ever needed. (This does **not**
imply the Caracal offline binary is a compute backend — it stays a static server, §7.)

### 5.1 Execution contexts — heavy compute must never block the UI thread

An architectural constraint, not just an optimization: parsing a large MD json and re-clustering on
every parameter change are heavy, and on the main thread they will freeze the interface. Target
topology:

```
Main thread            UI / interaction; charton rendering
  │  (structured-clone / Transferable messages — see below)
RDE Worker             Rust/WASM: MD json parse · clustering · stats · review decisions · export mask
Media Worker(s)        createImageBitmap · crop / resize · OffscreenCanvas   (later: WebCodecs)
```

- **P1 minimum:** the RDE/WASM work (parse + cluster) **must** run in a Worker. Media decode may
  start on the main thread for the tiny demo, but the interfaces must be Worker-ready (design the
  message boundary now). `ImageBitmap` is Transferable and `createImageBitmap` works in Workers, so
  moving media off-thread later is cheap.
- **Separate WASM instances → explicit DTO boundary.** If charton/WASM stays on the main thread
  while RDE/WASM runs in the Worker, they are **different WASM instances with different Rust heaps** —
  no shared memory. All cross-context communication (clusters, stats, decisions) must go through
  explicit serializable **DTOs / messages**, never shared pointers. Keep the DTOs small (charton
  needs aggregates, not every instance).

---

## 6. Data model & core contract (`rde-core`)

### 6.1 Two representations — original document + compact projection (core contract)

`rde-core` holds **two** things, and this separation is part of the contract:

```
OriginalMD    the parsed MD document, kept IMMUTABLE and COMPLETE (all fields, in order).
              rde-core does not model or interpret most of it.

Projection    the reduced view RDE actually runs on. Every projected detection keeps a STABLE
              back-reference into the original document:

  DetRef      (image_index, detection_index)          // stable coordinates into OriginalMD
  PDetection  { ref: DetRef, camera_id, category, conf, bbox:[f32;4], timestamp: Option<i64> }
  Camera      { id, key }                              // key = folder N levels up (§3)
  SuspiciousGroup {
      id, camera_id, category, rep_bbox:[f32;4],
      instances: Vec<Instance>,
      stats: { count, conf_min/median/max, time_span: Option<..> }
  }
  Instance    { ref: DetRef, bbox, conf, decision: Remove | Keep }   // default Remove
```

- RDE clustering/stats run **entirely against `Projection`**. Reclustering on a parameter change
  rebuilds `Projection` from `OriginalMD`, but the `DetRef` coordinates are invariant.
- **Export never reconstructs MD from `Projection`.** It walks decisions → collects the `DetRef`s to
  remove → applies that **mask to `OriginalMD`** (§6.3). This is what preserves unknown/future/video
  fields (§2.5).
- The review-session file is just the set of `DetRef` + decision, so it round-trips against the same
  original document later.

### 6.2 Path matching — must be ambiguity-safe

Camera-trap datasets reuse filenames heavily (`IMG_0001.JPG` under many camera folders), so a
basename fallback can **silently show the wrong image while looking fine**. Never auto-resolve an
ambiguous path. Rule, for matching a json `file` to a picked file's `webkitRelativePath`:

1. Normalize path separators to `/` (both sides).
2. Find the **longest matching path suffix** (component-wise) between the json path and the picked
   files.
3. Accept the match **only if it is unique** (exactly one picked file has that longest suffix).
4. Fall back to **basename-only** matching **only if that basename is unique among all picked
   files**.
5. Otherwise mark the item **ambiguous/unmatched** and report it — do not guess.

Surface unmatched *and* ambiguous counts loudly in the UI (both mean missing/incorrect tiles). Reuse
the separator-agnostic reasoning from `mediautil.media_basename`, but note that `media_basename`
alone is exactly the unsafe step (4) — suffix uniqueness (steps 2–3) is the primary matcher.

### 6.3 Apply semantics (per-instance, as a mask on the original)

Collect every `Instance` whose `decision == Remove` → its `DetRef`. Export produces `OriginalMD`
with those `(image_index, detection_index)` detections removed (or tagged — see below). `Keep` (incl.
a whole group rescued) leaves the original detection untouched. Per-instance removal is the new
behavior vs upstream's per-group all-or-none.

**Open (decide before P2):** hard-remove the detections, or **tag-and-filter** (add a marker so the
op is reversible/auditable and the original conf is retained). The mask-on-original design supports
either; leaning reversible.

---

## 7. Video (deferred — design only)

When video lands, RDE reviews boxes on specific **video frames**. To stay consistent with the
top-level architecture (one WASM app, identical online and offline, **all compute client-side**; the
offline binary is a dumb static server that never computes), video frames are decoded **in the
browser**.

- **Frame pixels, client-side, via WebCodecs.** `VideoDecoder` is available in current major desktop
  browsers, so it no longer forces a Chromium or native-ffmpeg fallback and the online/offline paths
  stay identical — but **API availability and codec/configuration support must be feature-detected at
  runtime** (`VideoDecoder.isConfigSupported`), not assumed from a version table. WebCodecs decodes
  *encoded chunks*, so you also need a **demuxer** to pull samples and locate the target frame —
  `mp4box.js`, or a Rust demuxer compiled to WASM (keeps it in `rde-core`). Decode from the preceding
  keyframe forward to reach the target frame.
- **Codec coverage:** whatever the browser decodes — H.264/AVC (the camera-trap default) is broadly
  supported; H.265/HEVC is patchy; AV1 increasingly OK. Gate with `VideoDecoder.isConfigSupported`.
- **Frame-number contract (correctness, P3 testing).** First establish **exactly what
  `frame_number` refers to** in the existing detection pipeline (`run_md_video.py` — what its
  `select`/frame counter actually indexes in presentation terms), rather than assuming "decode
  order" (decode order ≠ presentation order once B-frames exist). Then verify WebCodecs produces the
  **same presentation-frame sequence** for representative files/codecs. If that mapping is not stable
  across codecs/containers, persist or derive a **`frame_number` → presentation-timestamp (PTS)** map
  at detection time and use **timestamp as the authoritative lookup key**.
- **Media source:** the browser reads the `.mp4` `File` from the same `webkitdirectory` pick as the
  images — no upload, no server compute.
- **Virtual-frame mapping:** reuse our convention
  `"{frame_prefix}/{camera_key}__frame{NNNNNN}.jpg"` (`frame_prefix = "_rde_video_frames"`), camera =
  the *video's* camera. See the workflow reference files in §0. `combined_md.json` already carries
  `frame_number` per video detection, and our workflow already limits extraction to *suspicious*
  frames.
- **Optional escape hatch — NOT part of the app.** For codecs the browser can't decode, or very
  large videos, frames can be **pre-extracted out-of-band** by our existing workflow (native ffmpeg
  `select=eq(n,N)` + `ffmpeg_passthrough_args()` `-fps_mode`/`-vsync` fix + decode-timeout) into
  JPEGs the app then consumes exactly like images. This is a separate preprocessing tool — the
  offline binary still never computes, so the uniform architecture holds.

This same "media + frame_number → pixels" capability is also **upstream TODO #1** (video previews in
`postprocess_batch_results`).

Abstract it behind a **pixel provider** the tool calls: `image → pixels` (browser `createImageBitmap`),
`video + frame_number → pixels` (WebCodecs + demuxer). Phase-1 implements only images.

---

## 8. Time-based criteria (deferred — upstream TODO #4, E1)

Add a temporal signal to §3: the same box 100× **over a month** is far more likely FP than 100× **in
an hour**. Design:
- Per group, compute the timestamp span/density of its instances (needs §2.4 timestamps).
- Use as (a) an extra suspicious criterion / weight, and (b) a **sort + visualization** — and here
  Caracal's time plots are a natural fit (show a group's temporal footprint). This is the clean
  point of convergence between this tool and Caracal proper.

---

## 9. Build phases

1. **P1 — images POC (proves "will it work"):** load MD json + image folder (directory picker,
   §2.3) → cluster → render clickable box-crop tiles → export filtered json **as a mask on the
   original document** (§6.1). No frills. De-risks path-matching + browser decode + WASM clustering
   in one shot. **P1 constraints/tests:** RDE/WASM parse+cluster in a **Worker** (§5.1);
   **ambiguity-safe** path matching (§6.2); at least one **EXIF-rotated JPEG** regression asset
   verifying the bbox still overlays the object after decode (§5); export **preserves unknown MD
   fields** (diff a passthrough export against the input). The `rde-lab/demo/` dataset covers the
   clustering/per-instance cases; add the EXIF frame there.
2. **P2 — interactive:** live param sliders, per-instance keep, charton stats, review-session
   save/load.
3. **P3 — video:** client-side pixel provider (WebCodecs + demuxer, runtime feature-detected),
   virtual-frame mapping; native-ffmpeg pre-extraction only as an optional out-of-band escape hatch.
4. **P4 — time criteria** (§8), then generalize/clean for **upstream** (vanilla MD json, donate the
   find/apply split as the RDE-refactor reference).

---

## 10. Open questions
- Independent route in the Caracal app, or a separate WASM entry sharing the crate + build? (Leaning
  independent route, shared `rde-core`.)
- Apply = hard-remove detections, or tag-and-filter (reversible)? (Leaning reversible.)
- Camera inference: trust folder structure (`nDirLevelsFromLeaf`) only, or also allow a CSV/`deployment`
  column like Serval/our workflow?
- For datasets that exceed practical browser/WASM memory limits (§2.1): impose a documented
  input-size limit, or later implement streaming/indexed parsing? (Not a native-compute fallback —
  that would break the online≡offline browser architecture.)
