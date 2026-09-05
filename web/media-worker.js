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
const dirCache = new Map();         // "a/b/c" (dirs under root) -> FileSystemDirectoryHandle

const splitPath = (p) => p.replace(/\\/g, "/").split("/").filter(Boolean);

async function childDir(parent, name) {
  try { return await parent.getDirectoryHandle(name); }
  catch {
    // Case-insensitive / ambiguity fallback: enumerate THIS directory only.
    const lower = name.toLowerCase();
    for await (const [n, h] of parent.entries()) if (h.kind === "directory" && n.toLowerCase() === lower) return h;
    throw new Error("dir not found: " + name);
  }
}
async function childFile(parent, name) {
  try { return await parent.getFileHandle(name); }
  catch {
    const lower = name.toLowerCase();
    for await (const [n, h] of parent.entries()) if (h.kind === "file" && n.toLowerCase() === lower) return h;
    throw new Error("file not found: " + name);
  }
}

// Resolve a media path (its json path) to a File, via the retained handle.
async function resolveFile(path, strip = stripComponents) {
  if (!rootHandle) throw new Error("no folder has been picked yet");
  const parts = splitPath(path).slice(strip);
  const filename = parts.pop();
  let handle = rootHandle, key = "";
  for (const name of parts) {
    key = key ? key + "/" + name : name;
    let h = dirCache.get(key);
    if (!h) { h = await childDir(handle, name); dirCache.set(key, h); }
    handle = h;
  }
  const fh = await childFile(handle, filename);
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
async function detectOffset(samplePaths) {
  const candidates = [];
  for (const p of samplePaths) {
    const comps = splitPath(p);
    const idx = comps.lastIndexOf(rootHandle.name);
    if (idx >= 0 && idx < comps.length - 1) candidates.push(idx + 1);
  }
  for (let o = 0; o < 8; o++) candidates.push(o); // fallback: shallow offsets
  const probes = samplePaths.slice(0, 8);
  let best = null;
  const seen = new Set();
  for (const off of candidates) {
    if (seen.has(off)) continue; seen.add(off);
    let hits = 0;
    for (const probe of probes) {
      dirCache.clear();
      try { await resolveFile(probe, off); hits++; } catch { /* not this one */ }
    }
    if (hits > (best?.hits ?? 0)) best = { off, hits };
    if (hits === probes.length) break; // nothing can beat all of them
  }
  dirCache.clear();
  if (!best || best.hits === 0) throw new Error("could not align the folder to the json paths");
  return { offset: best.off, hits: best.hits, probes: probes.length };
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
      const aligned = await detectOffset(event.data.samplePaths);
      stripComponents = aligned.offset;
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
