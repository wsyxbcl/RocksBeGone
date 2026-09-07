// Media Worker (SPEC §5.1): decode + crop off the main thread so scrolling never
// janks. createImageBitmap is the decoder; an OffscreenCanvas does the crop. We
// return crops as small PNG Blobs (shown in <img>, which paint into the grid
// layer — a <canvas> per tile would each become its own compositor layer and
// freeze software compositing).
//
// Media-agnostic + batch-by-source: a "cropBatch" decodes ONE source once and
// emits all of its crops. That halves disk reads (many tiles share a source
// image) and is what makes video affordable — a clip is opened once and all of
// its requested frames come out of a single demux + decode pass (SPEC §5/§7).
//
// File access (SPEC §6.2): two modes. In the File System Access mode the worker
// holds the picked directory *handle* and resolves each media's known path
// lazily — walk root -> subdir -> file, caching directory handles, enumerating a
// single parent directory only as a case-insensitive fallback. NO global file
// index is ever built. In the fallback mode the main thread passes a File object
// (from a <input webkitdirectory> pick) and the worker just decodes it.

// Imported with this worker's own ?v= so bumping BUILD invalidates the whole
// graph — a versioned worker holding a stale cached import is a silent trap.
const BUILD = new URL(self.location.href).searchParams.get("v") || "dev";
const videoReady = import(`./video-frames.js?v=${BUILD}`);

const DECODE_W = 1000; // downscale cap: big camera images decode cheap + small
const TILE = 92;
const PAD = 0.6; // context padding around the box in a crop
// A 92px crop as lossless PNG measured 15 KB on the production document — 242 MB
// for 15,677 crops, which hit the cache ceiling two thirds of the way through a
// precompute pass. At this size the format is pure cache budget: nobody is
// pixel-peeping a 92px thumbnail, and the box outline is drawn by us, not
// recovered from the image.
const CROP_TYPE = "image/webp";
const CROP_QUALITY = 0.85;

// ---- File System Access resolution ----------------------------------------
let rootHandle = null;
let stripComponents = 0;            // leading json-path components to drop for the path under root
let rootPrefix = [];                // dirs to descend from the picked folder first (see detectOffset)
// Keyed by prefix + path-under-root, so entries stay valid across probes that
// try different prefixes and offsets. A `null` value is a remembered miss:
// during alignment most lookups fail, and re-walking a directory to re-discover
// the same absence is what made a wrong pick feel like a hang.
const dirCache = new Map();

const splitPath = (p) => p.replace(/\\/g, "/").split("/").filter(Boolean);

// Lowercased listing per directory, built at most once.
//
// Both lookups below fall back to enumeration when the exact name misses, which
// is what makes a json written on Windows resolve on a case-sensitive disk. The
// fallback is also hit by every *failed* probe during alignment, and a camera
// folder holds thousands of files — measured at 79,213 filesystem calls to align
// a correctly-picked folder, because each miss re-listed the same directory.
// Listing once turns that back into the handful of lookups it should be.
const listings = new Map(); // dir key -> Map(lowercased name -> handle)

async function listingOf(handle, key) {
  let listing = listings.get(key);
  if (listing) return listing;
  listing = new Map();
  for await (const [name, h] of handle.entries()) listing.set(name.toLowerCase(), h);
  listings.set(key, listing);
  return listing;
}

// `key` identifies the PARENT directory, so its listing can be reused.
//
// `strict` skips the case-insensitive fallback. The fallback is what makes a
// json written on Windows resolve on a case-sensitive disk, so it must stay for
// real lookups — but during a wide search most lookups are *meant* to miss, and
// paying a directory listing for each one is what made searching from two levels
// up cost tens of thousands of calls.
async function childDir(parent, name, key, strict = false) {
  try { return await parent.getDirectoryHandle(name); }
  catch {
    if (strict) throw new Error("dir not found: " + name);
    const hit = (await listingOf(parent, key)).get(name.toLowerCase());
    if (hit && hit.kind === "directory") return hit;
    throw new Error("dir not found: " + name);
  }
}
async function childFile(parent, name, key, strict = false) {
  try { return await parent.getFileHandle(name); }
  catch {
    if (strict) throw new Error("file not found: " + name);
    const hit = (await listingOf(parent, key)).get(name.toLowerCase());
    if (hit && hit.kind === "file") return hit;
    throw new Error("file not found: " + name);
  }
}

// Resolve a media path (its json path) to a File, via the retained handle.
//
// The path walked is `<picked folder>/<prefix>/<json path minus `strip` leading
// components>`. `strip` drops components the picked folder already accounts for;
// `prefix` descends into folders the json path never mentions, which is the case
// when someone picks a level or two above the directory the paths are relative
// to (SPEC §6.2).
async function resolveFile(path, strip = stripComponents, prefix = rootPrefix, strict = false) {
  if (!rootHandle) throw new Error("no folder has been picked yet");
  const parts = [...prefix, ...splitPath(path).slice(strip)];
  const filename = parts.pop();
  let handle = rootHandle, parentKey = "", key = "";
  for (const name of parts) {
    parentKey = key;
    key = key ? key + "/" + name : name;
    if (dirCache.has(key)) {
      const cached = dirCache.get(key);
      if (!cached) throw new Error("dir not found: " + name); // remembered miss
      handle = cached;
      continue;
    }
    let h;
    try { h = await childDir(handle, name, parentKey, strict); }
    catch (err) {
      // A strict miss is "not spelled exactly that", not "not there" — do not
      // let a search shortcut poison the cache for the real lookups later.
      if (!strict) dirCache.set(key, null);
      throw err;
    }
    dirCache.set(key, h);
    handle = h;
  }
  const fh = await childFile(handle, filename, key, strict);
  return fh.getFile();
}

// Find how many leading path components map to the picked folder, by probing
// sample paths (match the folder's own name first, then brute-force small
// offsets), so the user can pick any ancestor folder.
/// How many leading components of a json path the picked folder already covers.
///
/// This is the inference upstream does not have to make: its scripts are TOLD
/// the base directory (`--imageBase`), while a browser only hands us a folder
/// handle and its name.
///
/// Scored over several samples rather than accepted on the first one. A document
/// can mix path shapes — stills written one way, videos another — and an offset
/// that happens to resolve one sample and nothing else used to be accepted
/// silently, which surfaces as blank crops everywhere rather than as an error.
const MAX_DESCENT_DEPTH = 2;    // how many unmentioned levels a pick may sit above
const MAX_DIRS_PER_LEVEL = 200; // stop collecting after this many subfolders
const MAX_ENTRIES_SCANNED = 4000; // ...and stop *looking* after this many entries

/// Subfolder names directly under `handle`, bounded twice over.
///
/// Capping the folders collected is not enough: a camera folder is thousands of
/// files and no subfolders, and `entries()` yields the files too. Scanning one
/// such folder to learn it has no children cost 31,890 filesystem calls. Both
/// caps are deliberately generous — a media root with more than 200 camera
/// folders, or 4,000 entries before its first subfolder, is not a shape this
/// search needs to serve, and the user can always pick the folder directly.
async function childDirNames(handle) {
  const names = [];
  let scanned = 0;
  for await (const [name, h] of handle.entries()) {
    if (++scanned > MAX_ENTRIES_SCANNED) break;
    if (h.kind !== "directory") continue;
    names.push(name);
    if (names.length >= MAX_DIRS_PER_LEVEL) break;
  }
  return names;
}

async function detectOffset(samplePaths, onProgress = null) {
  const offsets = [];
  for (const p of samplePaths) {
    const comps = splitPath(p);
    const idx = comps.lastIndexOf(rootHandle.name);
    if (idx >= 0 && idx < comps.length - 1) offsets.push(idx + 1);
  }
  for (let o = 0; o < 8; o++) offsets.push(o); // fallback: shallow offsets
  const uniqueOffsets = [...new Set(offsets)];
  const probes = samplePaths.slice(0, 8);

  // Score one (prefix, offset) pair over every probe.
  const score = async (prefix, off) => {
    let hits = 0;
    for (const probe of probes) {
      try { await resolveFile(probe, off, prefix); hits++; } catch { /* not this one */ }
    }
    return hits;
  };

  let best = null;
  const consider = async (prefix, off) => {
    const hits = await score(prefix, off);
    if (hits > (best?.hits ?? 0)) best = { prefix, off, hits };
    return hits === probes.length;
  };

  // Phase 1 — the picked folder is the root the paths are relative to, or an
  // ancestor named in them. Unchanged, and still the only work done when the
  // pick is right.
  for (const off of uniqueOffsets) {
    if (await consider([], off)) return done(best, probes.length);
  }

  // Phase 2 — the pick is ABOVE the root, by folders the json never names.
  // Only reached when nothing above resolved, so the common case never pays for
  // it. Widening one probe at a time keeps a 200-child folder to 200 lookups
  // rather than 200 x 8 x offsets.
  let frontier = [[]];
  for (let depth = 0; depth < MAX_DESCENT_DEPTH; depth++) {
    const next = [];
    for (const prefix of frontier) {
      let parent = rootHandle;
      try {
        let key = "";
        for (const name of prefix) {
          parent = await childDir(parent, name, key);
          key = key ? key + "/" + name : name;
        }
      }
      catch { continue; }
      for (const name of await childDirNames(parent)) next.push([...prefix, name]);
    }
    if (!next.length) break;
    onProgress?.({ depth: depth + 1, candidates: next.length });

    // Cheap pass: one probe, offset 0 — the shape a correctly-structured
    // archive has once you are standing in the right place.
    const promising = [];
    for (const prefix of next) {
      try { await resolveFile(probes[0], 0, prefix, true); promising.push(prefix); }
      catch { /* not below here */ }
    }
    // Every promising prefix is scored, with no early exit, so a tie is seen
    // rather than resolved by directory order. Two folders that both hold the
    // media is a real shape — an archive kept beside a working copy — and
    // silently choosing one is how a reviewer ends up judging the wrong pixels.
    // `promising` is normally one entry, so this costs nothing in practice.
    const scored = [];
    for (const prefix of promising) {
      let localBest = null;
      for (const off of uniqueOffsets) {
        const hits = await score(prefix, off);
        if (hits > (localBest?.hits ?? 0)) localBest = { prefix, off, hits };
        if (hits === probes.length) break;
      }
      if (localBest?.hits) scored.push(localBest);
    }
    if (scored.length) {
      scored.sort((a, b) => b.hits - a.hits);
      best = scored[0];
      const tied = scored.filter((s) => s.hits === best.hits);
      return done(best, probes.length, tied.length > 1 ? tied.map((t) => t.prefix) : null);
    }
    frontier = next;
  }

  if (!best || best.hits === 0) throw new Error("could not align the folder to the json paths");
  return done(best, probes.length);
}

function done(best, probes, tiedWith = null) {
  return { offset: best.off, prefix: best.prefix, hits: best.hits, probes, tiedWith };
}

async function sourceFile(data) {
  return data.file || await resolveFile(data.path); // fallback File, or resolve by path
}

// ---- Decode + crop ---------------------------------------------------------
// `src` is anything drawImage accepts — an ImageBitmap (stills) or a VideoFrame
// (video), whose intrinsic size is displayWidth/Height rather than width/height.
async function cropBlob(src, bbox, srcW = src.width, srcH = src.height, timing = null) {
  const tDraw = performance.now();
  const off = new OffscreenCanvas(TILE, TILE);
  const ctx = off.getContext("2d");
  const [x, y, w, h] = bbox;
  const bx = x * srcW, by = y * srcH, bw = w * srcW, bh = h * srcH;
  const cx = Math.max(0, bx - bw * PAD), cy = Math.max(0, by - bh * PAD);
  const cw = Math.min(srcW - cx, bw * (1 + 2 * PAD));
  const ch = Math.min(srcH - cy, bh * (1 + 2 * PAD));
  const scale = Math.min(TILE / cw, TILE / ch);
  const dw = cw * scale, dh = ch * scale, dx = (TILE - dw) / 2, dy = (TILE - dh) / 2;
  // The crop's own backdrop and box outline. A worker has no CSS, and these are
  // baked into a cached image, so they cannot follow the theme — they are chosen
  // to sit acceptably on either. The outline stays amber for the same reason it
  // always was: it must not be confused with the keep/remove border the tile
  // draws around it.
  ctx.fillStyle = "#8a8a90";
  ctx.fillRect(0, 0, TILE, TILE);
  ctx.drawImage(src, cx, cy, cw, ch, dx, dy, dw, dh);
  // Same red the full-frame preview uses for the detection under review —
  // the same box was two different colours depending on where you looked.
  ctx.strokeStyle = "#ee6666";
  ctx.lineWidth = 2;
  ctx.strokeRect(dx + (bx - cx) * scale, dy + (by - cy) * scale, bw * scale, bh * scale);
  const tEncode = performance.now();
  // convertToBlob silently falls back to png for an unsupported type, so the
  // result is correct either way — just bigger.
  const blob = await off.convertToBlob({ type: CROP_TYPE, quality: CROP_QUALITY });
  if (timing) {
    timing.drawMs += tEncode - tDraw;
    timing.encodeMs += performance.now() - tEncode;
    timing.bytes += blob.size;
    timing.count++;
  }
  return blob;
}

const newTiming = () => ({ drawMs: 0, encodeMs: 0, bytes: 0, count: 0 });
const roundTiming = (t) => ({
  drawMs: +t.drawMs.toFixed(1), encodeMs: +t.encodeMs.toFixed(1),
  thumbBytes: t.bytes, thumbs: t.count,
});
function decodeSource(file, width = DECODE_W) {
  return createImageBitmap(file, { imageOrientation: "from-image", resizeWidth: width, resizeQuality: "medium" });
}

// One whole video frame, as an ImageBitmap the preview can draw. The bitmap is
// taken while the VideoFrame is still open, since extractFrames closes it.
async function videoFrameBitmap(file, frameNumber, width = 0) {
  const { extractFrames, DEMUXABLE } = await videoReady;
  if (!DEMUXABLE.test(file.name)) throw new Error(`no in-browser demuxer for .${file.name.split(".").pop().toLowerCase()} files`);
  let bitmap = null;
  await extractFrames(file, [frameNumber], async (_number, frame) => {
    const shrink = width && frame.displayWidth > width; // never upscale
    bitmap = await createImageBitmap(frame, shrink ? { resizeWidth: width, resizeQuality: "medium" } : undefined);
  });
  if (!bitmap) throw new Error(`frame ${frameNumber} not found`);
  return bitmap;
}

// Crop several detections out of one clip (SPEC §7). Several boxes can sit on
// the same frame, so requests are grouped by frame and that frame is decoded
// once. Returns the crops plus decode stats for the caller to log.
async function cropVideo(file, items, ablate) {
  const { extractFrames, DEMUXABLE } = await videoReady;
  if (!DEMUXABLE.test(file.name)) throw new Error(`no in-browser demuxer for .${file.name.split(".").pop().toLowerCase()} files`);
  const byFrame = new Map();
  for (const it of items) {
    const frame = it.frameNumber;
    if (frame === undefined) continue; // a still's box on a video source: nothing to seek to
    if (!byFrame.has(frame)) byFrame.set(frame, []);
    byFrame.get(frame).push(it);
  }
  const results = [];
  const timing = newTiming();
  const harvest = async (number, frame) => {
    for (const it of byFrame.get(number) || []) {
      results.push({ key: it.key, blob: await cropBlob(frame, it.bbox, frame.displayWidth, frame.displayHeight, timing) });
    }
  };
  // Keep whatever decoded. Camera files do get damaged (ffmpeg reports e.g.
  // "error while decoding MB 82 94" and carries on; WebCodecs just throws), and
  // one bad frame should cost that frame's crops, not the whole clip's.
  let failure = null;
  let stats = {};
  try {
    stats = await extractFrames(file, [...byFrame.keys()], harvest, { ablate });
  } catch (err) {
    failure = String(err?.message || err);
  }
  return { results, stats: { kind: "video", ...stats, failure, ...roundTiming(timing) } };
}

self.onmessage = async (event) => {
  const { id, kind, file, path, bbox, items } = event.data;
  try {
    if (kind === "setRoot") {
      rootHandle = event.data.rootHandle;
      dirCache.clear();
      listings.clear();
      rootPrefix = [];
      stripComponents = 0;
      // The second worker is handed the alignment the first one found rather
      // than repeating the search.
      const given = event.data.align;
      // Descending can take a moment on a wide folder; say so rather than let
      // the page sit silent.
      const aligned = given
        ? { offset: given.offset, prefix: given.prefix || [], hits: 0, probes: 0 }
        : await detectOffset(event.data.samplePaths, (p) =>
            self.postMessage({ id, progress: true, ...p }));
      stripComponents = aligned.offset;
      rootPrefix = aligned.prefix || [];
      self.postMessage({ id, ok: true, ...aligned });
      return;
    }
    if (kind === "frame") {
      // Full frame for the "in context" preview — a still, or one video frame.
      // Sized here rather than on the main thread: the caller only draws it a few
      // hundred px wide, and a 5 MP bitmap is expensive to transfer and redraw.
      const file = await sourceFile(event.data);
      const width = event.data.maxWidth || DECODE_W;
      const src = event.data.frameNumber === undefined
        ? await decodeSource(file, width)
        : await videoFrameBitmap(file, event.data.frameNumber, width);
      self.postMessage({ id, ok: true, bitmap: src, width: src.width, height: src.height }, [src]);
      return;
    }
    if (kind === "cropBatch") {
      const file = await sourceFile(event.data);
      // Video: one demux + decode pass yields every requested frame's crops.
      if (items.some((it) => it.frameNumber !== undefined)) {
        self.postMessage({ id, ok: true, ...(await cropVideo(file, items, event.data.ablate)) });
        return;
      }
      // Stills: same phase breakdown as video, so the two are comparable.
      const tDecode = performance.now();
      const src = await decodeSource(file); // one source open -> all its crops
      const tCrop = performance.now();
      const results = [];
      const timing = newTiming();
      for (const it of items) results.push({ key: it.key, blob: await cropBlob(src, it.bbox, src.width, src.height, timing) });
      src.close();
      self.postMessage({
        id, ok: true, results,
        stats: {
          kind: "image", bytesTotal: file.size, bytesRead: file.size,
          width: src.width, height: src.height, targets: items.length,
          decodeMs: +(tCrop - tDecode).toFixed(1),
          totalMs: +(performance.now() - tDecode).toFixed(1),
          ...roundTiming(timing),
        },
      });
      return;
    }
    // single crop
    const src = await decodeSource(await sourceFile(event.data));
    const blob = await cropBlob(src, bbox);
    src.close();
    self.postMessage({ id, ok: true, blob });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) }); // e.g. video, unreadable, or not found
  }
};
