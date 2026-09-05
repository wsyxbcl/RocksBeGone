// Video frame extraction (SPEC §7): the pixel provider's `video + frame_number
// -> pixels` half. mp4box.js demuxes the container (WebCodecs only decodes
// *encoded chunks* — it can't open a file), the browser's VideoDecoder decodes.
//
// `frame_number` is ffmpeg's `n`: the 0-based **presentation-order** frame index
// from the start of the clip (that is what run_md_video.py's `select` counts).
// Decode order is not presentation order once B-frames exist, so we sort samples
// by composition time to find the target, and match decoded frames back **by
// timestamp** rather than by output order.
//
// Decode strategy: RDE wants a handful of known frames per clip, not the whole
// clip, so decoding linearly is usually waste. We map each target back to its
// preceding random-access point, merge the resulting ranges, and only fall back
// to a full linear pass when those ranges already cover most of the clip.
// Measured on the demo set, merging decodes 6-12% of a linear pass at realistic
// (1-3 s) keyframe intervals.

import { createFile, DataStream, Endianness, MP4BoxBuffer } from "./vendor/mp4box.all.mjs";

/// Containers mp4box.js can demux. `.avi`/`.mkv` need a different demuxer and
/// fall back to the out-of-band ffmpeg pre-extraction escape hatch (SPEC §7).
export const DEMUXABLE = /\.(mp4|m4v|mov)$/i;

// Two ranges closer than this are decoded as one: pushing a few extra frames
// through the decoder costs less than a decoder discontinuity plus another seek
// on a spinning disk.
const GAP_MERGE = 15;
// Above this share of the clip, merging has stopped paying for itself — just run
// the whole track in one pass and skip the bookkeeping.
const LINEAR_COVERAGE = 0.7;
// Keep the decoder fed without queueing the whole range at once.
const QUEUE_HIGH_WATER = 24;

// Measured on the production set: a read costs ~79 ms whatever its size, while
// large reads move ~89 MB/s. So requests, not bytes, are the currency — the
// first byte-range build fetched 9x less data in 4.3 requests per clip and came
// out SLOWER than reading whole files. Everything below is sized to keep the
// count near two: one to find the layout, one to take what we need.
const HEADER_PROBE = 1024 * 1024; // ftyp + a fast-start moov in a single read
const HEADER_STEP = 2 * 1024 * 1024; // moov median is 0.53 MB; one read after the jump
const TAIL_PROBE = 2 * 1024 * 1024; // covers a trailing moov and the scan for it
const MAX_HEADER_STEPS = 8;
// Two sample ranges closer than this are fetched as one: the bytes in between
// cost less than the extra request would.
const COALESCE_BYTES = 2 * 1024 * 1024;
// Samples fetched per backwards verification step. One read of ~64 samples
// beats 64 reads of one, and a GOP is rarely longer.
const VERIFY_WINDOW = 64;

/// Byte-range reader over a File. Fetches only what it is asked for, remembers
/// what it already holds, and hands out views by absolute file offset — which is
/// how the sample table addresses everything.
class RangeReader {
  constructor(file) {
    this.file = file;
    this.chunks = []; // sorted, non-overlapping { start, end, bytes }
    this.bytesRead = 0;
    this.reads = 0;
    this.ioMs = 0; // so readMs stays "time spent on I/O" and comparable to before
  }

  /// Sub-intervals of [start, end) not already held.
  missing(start, end) {
    const gaps = [];
    let cursor = start;
    for (const chunk of this.chunks) {
      if (chunk.end <= cursor) continue;
      if (chunk.start >= end) break;
      if (chunk.start > cursor) gaps.push([cursor, Math.min(chunk.start, end)]);
      cursor = Math.max(cursor, chunk.end);
      if (cursor >= end) break;
    }
    if (cursor < end) gaps.push([cursor, end]);
    return gaps;
  }

  async ensure(start, end) {
    const stop = Math.min(end, this.file.size);
    const from = Math.max(0, start);
    if (from >= stop) return;
    for (const [a, b] of this.missing(from, stop)) {
      const t = performance.now();
      const buffer = await this.file.slice(a, b).arrayBuffer();
      this.ioMs += performance.now() - t;
      this.chunks.push({ start: a, end: b, bytes: new Uint8Array(buffer) });
      this.chunks.sort((x, y) => x.start - y.start);
      this.bytesRead += b - a;
      this.reads++;
    }
  }

  bytes(offset, size) {
    for (const chunk of this.chunks) {
      if (offset >= chunk.start && offset + size <= chunk.end) {
        const at = offset - chunk.start;
        return chunk.bytes.subarray(at, at + size); // the common case: no copy
      }
    }
    // A sample can straddle two reads — `ensure` only fetches the parts it is
    // missing, so a range half-covered by the header read arrives as neighbours.
    // Stitch them, which is the only case that costs a copy.
    const out = new Uint8Array(size);
    let filled = 0;
    for (const chunk of this.chunks) {
      const at = offset + filled;
      if (chunk.end <= at) continue;
      if (chunk.start > at) break; // gap: genuinely never read
      const take = Math.min(chunk.end - at, size - filled);
      out.set(chunk.bytes.subarray(at - chunk.start, at - chunk.start + take), filled);
      filled += take;
      if (filled === size) return out;
    }
    throw new Error(`byte range ${offset}+${size} was never read`);
  }
}

/// A `moov` box in `bytes` whose extent ends exactly at EOF, or null. Boxes are
/// [u32 size][u32 type], and there is no trailing index in MP4, so the exact-fit
/// check is what makes scanning backwards safe rather than a guess.
function findTrailingMoov(bytes, tailStart, fileSize) {
  for (let p = bytes.length - 8; p >= 0; p--) {
    if (bytes[p + 4] !== 0x6d || bytes[p + 5] !== 0x6f || bytes[p + 6] !== 0x6f || bytes[p + 7] !== 0x76) continue;
    const size = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    if (size >= 8 && tailStart + p + size === fileSize) return tailStart + p;
  }
  return null;
}

/// Read just enough of the container to build the sample table.
///
/// Most camera files put `moov` AFTER the payload — 30 of 36 clips in the bench
/// set are `ftyp,mdat…,moov` — so streaming from the front would read the whole
/// file to reach the tables. mp4box's `appendBuffer` returns the position it
/// wants next, and that skips over `mdat`, so following it lands on the moov
/// wherever it lives.
async function readHeader(reader, file) {
  const mp4 = createFile();
  let info = null, failure = null;
  mp4.onReady = (parsed) => { info = parsed; };
  mp4.onError = (error) => { failure = error; };
  let position = 0;
  let shortcut = false;
  for (let step = 0; step < MAX_HEADER_STEPS && !info && !failure; step++) {
    const end = Math.min(file.size, position + (step ? HEADER_STEP : HEADER_PROBE));
    if (position >= end) break;
    await reader.ensure(position, end);
    const window = reader.bytes(position, end - position).slice(); // mp4box keeps it
    const next = mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(window.buffer, position));
    if (info || failure) break;
    position = typeof next === "number" && next > position ? next : end;

    // The parser advances one box at a time, and reaching `moov` past two `mdat`
    // boxes costs a whole request per header — a 2 MB read to learn 16 bytes. The
    // moov is the last box in every camera file seen here, so find it directly
    // and bridge the gap with a synthetic box header. Tried once; if the moov is
    // not at EOF the walk simply carries on.
    if (!shortcut && position < file.size) {
      shortcut = true;
      const tailStart = Math.max(position, file.size - TAIL_PROBE);
      await reader.ensure(tailStart, file.size);
      const moovStart = findTrailingMoov(
        reader.bytes(tailStart, file.size - tailStart), tailStart, file.size,
      );
      const gap = moovStart === null ? -1 : moovStart - position;
      if (gap >= 8 && gap < 0xffffffff) {
        // Specifically `mdat`, not `free`: mp4box reads the payload of every box
        // it parses except mdat (`if (this.type !== "mdat") this.data = …`), so
        // any other type would make it wait for tens of MB we deliberately never
        // fetched. We read sample bytes ourselves, so a synthetic mdat costs
        // nothing — it exists only to move the parser forward.
        const skip = new Uint8Array(8);
        new DataView(skip.buffer).setUint32(0, gap);
        skip.set([0x6d, 0x64, 0x61, 0x74], 4); // "mdat"
        mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(skip.buffer, position));
        const tail = reader.bytes(moovStart, file.size - moovStart).slice();
        mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(tail.buffer, moovStart));
        if (info) break;
      } else if (gap === 0) {
        continue; // already sitting on the moov; the normal read handles it
      }
    }
  }
  return { mp4, info, failure };
}

/// Demux `file` and return its video track plus the full sample table. Samples
/// carry absolute file offsets, which the reader resolves against whatever it
/// has fetched — mp4box never has to copy the payload back to us.
async function demux(file, ablate) {
  const tRead = performance.now();
  const reader = new RangeReader(file);
  let mp4 = null, info = null, failure = null;
  let wholeFile = ablate.has("wholefile"); // ablation: read it all, as we used to
  if (!wholeFile) ({ mp4, info, failure } = await readHeader(reader, file));
  if (!info && !failure) {
    // An unfamiliar layout is not worth failing over: read it all and re-parse.
    wholeFile = true;
    mp4 = null;
    await reader.ensure(0, file.size);
    mp4 = createFile();
    mp4.onReady = (parsed) => { info = parsed; };
    mp4.onError = (error) => { failure = error; };
    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(reader.bytes(0, file.size).slice().buffer, 0));
    mp4.flush();
  }
  if (failure) throw new Error(`demux failed: ${failure}`);
  if (!info) throw new Error("no moov box — this file is not a readable MP4");
  const track = info.videoTracks?.[0];
  if (!track) throw new Error("this file has no video track");
  const samples = mp4.getTrackById(track.id).samples;
  if (!samples?.length) throw new Error("this file's video track is empty");
  return {
    reader, mp4, track, samples, wholeFile,
    headerBytes: reader.bytesRead,
    headerReads: reader.reads,
    headerMs: performance.now() - tRead,
  };
}

/// The codec's out-of-band configuration (avcC/hvcC/…), which `VideoDecoder`
/// needs as `description` for length-prefixed (non-Annex-B) samples.
function codecDescription(mp4, trackId) {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) continue;
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
  }
  return undefined; // some codecs (e.g. AnnexB-in-MP4) need none
}

/// Does this sample contain a random-access NAL unit? Samples are stored as
/// length-prefixed NAL units (AVCC/HVCC), so this walks the prefixes and looks
/// for an IDR (H.264 type 5) or IRAP (HEVC types 16-23).
export function sampleIsRandomAccess(bytes, nalLengthSize, isHevc) {
  let p = 0;
  while (p + nalLengthSize <= bytes.length) {
    let length = 0;
    for (let i = 0; i < nalLengthSize; i++) length = length * 256 + bytes[p + i];
    p += nalLengthSize;
    if (length <= 0 || p + length > bytes.length) break;
    const header = bytes[p];
    if (isHevc ? ((header >> 1) & 0x3f) >= 16 && ((header >> 1) & 0x3f) <= 23 : (header & 0x1f) === 5) {
      return true;
    }
    p += length;
  }
  return false;
}

/// Sync flags per sample, verified against the bitstream only where it matters.
///
/// ISO/IEC 14496-12: when a track has no `stss` box, *every* sample is by
/// definition a sync sample, and mp4box reports that faithfully. Plenty of
/// camera MP4s omit `stss` while still encoding P-frames — 27 of the 36 clips in
/// the bench set do — and trusting the flag there makes every "keyframe" a
/// P-frame, which WebCodecs rejects ("marked as type key but wasn't a key
/// frame") or silently decodes to nothing.
///
/// The old repair scanned every sample, which needed the whole file. Under
/// byte-range reads we instead verify backwards from each frame we want, which
/// touches precisely the samples we were about to decode anyway — the check is
/// nearly free, because those bytes have to be fetched regardless.
class SyncTable {
  constructor(samples, config, reader) {
    this.samples = samples;
    this.reader = reader;
    this.flags = samples.map((s) => !!s.is_sync);
    this.checked = new Uint8Array(samples.length);
    this.repaired = false;

    const codec = (config.codec || "").toLowerCase();
    this.isHevc = codec.startsWith("hev") || codec.startsWith("hvc");
    const known = this.isHevc || codec.startsWith("avc");
    // Only all-sync tracks are suspect; a real `stss` is trustworthy, and an
    // unknown codec is not ours to second-guess.
    this.suspect = known && samples.length > 1 && this.flags.every(Boolean);
    // Length-prefix size lives in the codec config: avcC byte 4, hvcC byte 21.
    const at = this.isHevc ? 21 : 4;
    const desc = config.description;
    this.nalLengthSize = desc && desc.length > at ? (desc[at] & 0x03) + 1 : 4;
  }

  /// One contiguous read covering samples [from, to] — they are adjacent in the
  /// file, so this is one request rather than one per sample.
  async fetchSamples(from, to) {
    const first = this.samples[from], last = this.samples[to];
    await this.reader.ensure(first.offset, last.offset + last.size);
  }

  async check(index) {
    if (this.checked[index]) return this.flags[index];
    const sample = this.samples[index];
    const real = sampleIsRandomAccess(
      this.reader.bytes(sample.offset, sample.size), this.nalLengthSize, this.isHevc,
    );
    if (this.flags[index] && !real) this.repaired = true;
    this.flags[index] = real;
    this.checked[index] = 1;
    return real;
  }

  /// Nearest real random-access point at or before `index`, verifying every
  /// sample in between — which is exactly the span that will be decoded.
  async lastRandomAccessAtOrBefore(index) {
    for (let end = index; end >= 0; end -= VERIFY_WINDOW) {
      const start = Math.max(0, end - VERIFY_WINDOW + 1);
      await this.fetchSamples(start, end);
      for (let i = end; i >= start; i--) if (await this.check(i)) return i;
    }
    return null; // no IDR anywhere before it; caller keeps the container's word
  }

  /// Every sample in [from, to] gets a real flag. Merging two ranges can span
  /// samples nobody walked past, and those are decoded too, so their key/delta
  /// labels have to be right.
  async verifyRange(from, to) {
    for (let start = from; start <= to; start += VERIFY_WINDOW) {
      const end = Math.min(to, start + VERIFY_WINDOW - 1);
      let pending = false;
      for (let i = start; i <= end; i++) if (!this.checked[i]) { pending = true; break; }
      if (!pending) continue;
      await this.fetchSamples(start, end);
      for (let i = start; i <= end; i++) await this.check(i);
    }
  }

  get keyframes() {
    return this.flags.reduce((n, k) => n + (k ? 1 : 0), 0);
  }
}

/// Which sample ranges must be decoded to reach `targets` (presentation-order
/// frame indices). Exported for testing — this is pure index arithmetic.
/// `isSync` overrides the container's flags when they have been repaired.
export function planRanges(samples, targets, isSync, forceLinear = false) {
  // Presentation order: sort by composition time, ties by decode order.
  const presentation = samples
    .map((_, index) => index)
    .sort((a, b) => samples[a].cts - samples[b].cts || a - b);

  // Nearest random-access point at or before each sample, precomputed.
  const sync_ = isSync || samples.map((s) => !!s.is_sync);
  const lastSync = new Int32Array(samples.length);
  let sync = 0;
  for (let i = 0; i < samples.length; i++) {
    if (sync_[i]) sync = i;
    lastSync[i] = sync;
  }

  const wanted = new Map(); // decode index -> frame number
  const missing = [];
  for (const frame of targets) {
    const index = presentation[frame];
    if (index === undefined) missing.push(frame);
    else wanted.set(index, frame);
  }

  const merged = [];
  for (const index of [...wanted.keys()].sort((a, b) => a - b)) {
    const start = lastSync[index];
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + GAP_MERGE) last[1] = Math.max(last[1], index);
    else merged.push([start, index]);
  }

  const cost = merged.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
  if (forceLinear || cost > samples.length * LINEAR_COVERAGE) {
    return { ranges: [[0, samples.length - 1]], wanted, missing, linear: true, cost: samples.length };
  }
  return { ranges: merged, wanted, missing, linear: false, cost };
}

/// Decode the frames `targets` (presentation-order indices) out of `file`,
/// calling `onFrame(frameNumber, videoFrame)` for each. The frame is closed as
/// soon as `onFrame` resolves — copy anything you need out of it first. Frames
/// decoded only to *reach* a target are closed without ever reaching `onFrame`.
/// Returns decode statistics.
export async function extractFrames(file, targets, onFrame, options = {}) {
  if (typeof VideoDecoder === "undefined") throw new Error("this browser has no WebCodecs, so video frames cannot be decoded");
  // Systems ablation: force a component off so its contribution can be measured
  // rather than argued about. Empty in normal use.
  const ablate = new Set(options.ablate || []);

  const tStart = performance.now();
  const { reader, mp4, track, samples, wholeFile, headerMs, headerBytes, headerReads } = await demux(file, ablate);
  const tConfig = performance.now();

  const config = {
    codec: track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    description: codecDescription(mp4, track.id),
    optimizeForLatency: true,
  };
  if (!(await VideoDecoder.isConfigSupported(config)).supported) {
    throw new Error(`codec not supported: ${track.codec}`);
  }

  const tPlan = performance.now();
  const ioBeforePlan = reader.ioMs;
  const sync = new SyncTable(samples, config, reader);
  const isSync = sync.flags;
  const timescale = track.timescale;
  const stamp = (sample) => Math.round((sample.cts * 1e6) / timescale);
  const chunkFor = (index) => new EncodedVideoChunk({
    type: isSync[index] ? "key" : "delta",
    timestamp: stamp(samples[index]),
    duration: Math.round((samples[index].duration * 1e6) / timescale),
    data: reader.bytes(samples[index].offset, samples[index].size),
  });

  // Plan, verify, re-plan, fetch. The first pass exists only to learn WHICH
  // samples we want: with a suspect all-sync table its ranges are wrong, because
  // every sample claims to be a keyframe and so every range is one frame long.
  // Walking back from each wanted sample finds the real random-access point.
  async function preparePlan(wanted) {
    let plan = planRanges(samples, wanted, isSync, ablate.has("linear"));
    if (sync.suspect) {
      const indices = [...plan.wanted.keys()].sort((a, b) => a - b);
      // Fetch everything the walks are about to read, in one go. Walking each
      // target separately asks for adjacent spans in sequence, and each one is
      // another round trip — the dominant cost. Targets in a clip are usually
      // close, so this is a single request that also covers the decode range.
      await fetchSpans(indices.map((i) => [Math.max(0, i - VERIFY_WINDOW), i]));
      for (const index of indices) await sync.lastRandomAccessAtOrBefore(index);
      plan = planRanges(samples, wanted, isSync, ablate.has("linear"));
      // Range starts are now real random-access points and can only move earlier,
      // never later, so this needs no further re-plan — but the samples a merge
      // swallowed between two targets still need honest key/delta labels.
      for (const [from, to] of plan.ranges) await sync.verifyRange(from, to);
    }
    await fetchSpans(plan.ranges);
    return plan;
  }

  /// Fetch the bytes for sample ranges in as few requests as possible: ranges
  /// whose gap is smaller than COALESCE_BYTES are taken together, because the
  /// bytes in between cost less than another round trip.
  async function fetchSpans(ranges) {
    const spans = ranges
      .map(([from, to]) => [samples[from].offset, samples[to].offset + samples[to].size])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span[0] - last[1] <= COALESCE_BYTES) last[1] = Math.max(last[1], span[1]);
      else merged.push(span);
    }
    for (const [from, to] of merged) await reader.ensure(from, to);
  }

  const firstPlan = await preparePlan(targets);
  // The probe measures from the first random-access point and may run PAST the
  // planned range — a range can be a single sample, and one frame measures
  // configure() rather than decode. Those samples are contiguous, so they decode
  // cleanly, but their bytes have to be fetched like any others.
  const probeStart = firstPlan.ranges[0]?.[0];
  const probeFrames = Math.max(PROBE_MIN_FRAMES, Math.min(PROBE_MAX_FRAMES, firstPlan.cost));
  const probeEnd = probeStart === undefined
    ? undefined
    : Math.min(samples.length - 1, probeStart + probeFrames - 1);
  if (probeStart !== undefined && !preferences.has(fingerprint(config))) {
    await reader.ensure(samples[probeStart].offset, samples[probeEnd].offset + samples[probeEnd].size);
  }
  const mode = ablate.has("software") ? "prefer-software" : await preferredMode(config, probeFrames, () => {
    if (probeStart === undefined) return [];
    const chunks = [];
    for (let i = probeStart; i <= probeEnd; i++) chunks.push(chunkFor(i));
    return chunks;
  });

  const tDecodeStart = performance.now();
  const delivered = new Set();
  let decoded = 0, onFrameMs = 0, plan = firstPlan;

  // One decode attempt, over whatever targets are still outstanding. Separated
  // so a hardware failure can be retried in software without re-delivering the
  // frames that already made it through.
  async function attempt(acceleration, wanted, prepared) {
    plan = prepared || await preparePlan(wanted);
    const byTimestamp = new Map();
    for (const [index, frame] of plan.wanted) byTimestamp.set(stamp(samples[index]), frame);
    const cropping = [];
    let failure = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        decoded++;
        const number = byTimestamp.get(frame.timestamp);
        if (number === undefined) {
          frame.close(); // decoded only to reach a target
          return;
        }
        byTimestamp.delete(frame.timestamp);
        // Crop before closing; VideoFrames hold scarce decoder-pool memory.
        cropping.push(
          (async () => {
            const t = performance.now();
            try {
              await onFrame(number, frame);
              delivered.add(number);
            } finally {
              frame.close();
              // Overlaps decode, so it is NOT additive with decodeMs — recorded
              // separately so the two can be told apart.
              onFrameMs += performance.now() - t;
            }
          })(),
        );
      },
      error: (error) => { failure = error; },
    });
    decoder.configure({ ...config, hardwareAcceleration: acceleration });

    for (const [start, end] of plan.ranges) {
      for (let index = start; index <= end && !failure; index++) {
        decoder.decode(chunkFor(index));
        if (decoder.decodeQueueSize >= QUEUE_HIGH_WATER) await drain(decoder);
      }
    }
    if (!failure) await decoder.flush().catch((err) => { failure = err; });
    if (decoder.state !== "closed") decoder.close();
    await Promise.all(cropping);
    return { failure, undelivered: [...byTimestamp.values()] };
  }

  let accel = mode;
  let result = await attempt(accel, targets, firstPlan);
  if (result.failure && accel !== "prefer-software") {
    // Retry only what never arrived, so partial progress is not re-cropped.
    const remaining = targets.filter((t) => !delivered.has(t));
    if (!remaining.length) {
      result = { failure: null, undelivered: [] };
    } else {
      accel = "prefer-software";
      const retry = await attempt(accel, remaining);
      if (!retry.failure) noteHardwareFailure(config);
      result = retry;
    }
  }
  const tDecodeEnd = performance.now();
  if (result.failure) throw result.failure;

  const frames = track.nb_samples ?? samples.length;
  return {
    // What this clip is
    codec: track.codec,
    width: track.video?.width,
    height: track.video?.height,
    durationS: track.duration && track.timescale ? +(track.duration / track.timescale).toFixed(1) : null,
    bytesTotal: file.size,
    bytesRead: reader.bytesRead, // header + the sample ranges actually decoded
    reads: reader.reads,         // how many slice() requests that took
    headerBytes,                 // of which, finding the sample table
    headerReads,
    wholeFile,                   // fell back to reading everything

    // What we asked of it
    frames,
    targets: targets.length,
    planned: plan.cost, // frames the plan says must be decoded
    decoded, // frames the decoder actually emitted
    coverage: +(plan.cost / frames).toFixed(3), // planned share of the clip
    ranges: plan.ranges.length,
    linear: plan.linear,
    syncRepaired: sync.repaired, // container claimed every sample was a keyframe
    syncSuspect: sync.suspect,   // ...and so had to be checked against the bitstream
    keyframes: sync.keyframes,   // among samples checked; the rest keep their flag
    missing: [...plan.missing, ...result.undelivered],
    accel, // what the probe picked, or "prefer-software" after a demotion
    ablated: ablate.size ? [...ablate] : undefined,
    // What the probe actually measured, so "why software?" is answerable from a
    // dump instead of needing the console line from the right moment.
    probe: preferences.get(fingerprint(config)) || null,

    // Where the time went (readMs..decodeMs are sequential and additive;
    // onFrameMs runs *inside* decodeMs)
    readMs: +reader.ioMs.toFixed(1), // all I/O: header + sample ranges
    headerMs: +headerMs.toFixed(1),  // of which, reaching the sample table
    configMs: +(tPlan - tConfig).toFixed(1),
    // Plan + verify, with the fetching taken out: readMs already owns that, and
    // an overlapping phase table cannot be read as a budget.
    planMs: +Math.max(0, tDecodeStart - tPlan - (reader.ioMs - ioBeforePlan)).toFixed(1),
    decodeMs: +(tDecodeEnd - tDecodeStart).toFixed(1),
    onFrameMs: +onFrameMs.toFixed(1),
    totalMs: +(performance.now() - tStart).toFixed(1),
  };
}

// ---- Which decoder to ask for ---------------------------------------------
// Nothing reports whether a decode actually used hardware, and hardware is not
// reliably faster: setup latency dominates short jobs, integrated decoders can
// be slower than an optimised software path, and some cameras write streams a
// hardware decoder rejects but a software one accepts. So we time both on this
// device's own files and keep the winner.
//
// Keyed by codec fingerprint rather than by machine: one document can hold
// several profiles, and the answer can differ between them.
// Hardware decoders cost far more to configure than software ones, so too short
// a probe measures setup rather than decode and picks software every time. But
// the right length is a property of the DOCUMENT, not a number from one camera
// set: a clip that decodes three frames is not served by a forty-frame verdict.
// So the probe runs whatever this clip's own plan asks for, within reason.
const PROBE_MIN_FRAMES = 8;
const PROBE_MAX_FRAMES = 64;
const HW_TIE_MARGIN = 1.1; // hardware wins ties: it also frees CPU for other clips
const preferences = new Map(); // fingerprint -> { mode, hwMs, swMs, demoted }
const probing = new Map();     // fingerprint -> in-flight probe, so clips don't race

const fingerprint = (config) => `${config.codec} ${config.codedWidth}x${config.codedHeight}`;

/// Decode `chunks` under one acceleration mode; ms, or null if it won't run.
async function timeDecode(config, mode, chunks) {
  const candidate = { ...config, hardwareAcceleration: mode };
  let support;
  try {
    support = await VideoDecoder.isConfigSupported(candidate);
  } catch { return null; }
  if (!support.supported) return null;
  let failed = null;
  const decoder = new VideoDecoder({ output: (frame) => frame.close(), error: (err) => { failed = err; } });
  const t = performance.now();
  try {
    decoder.configure(candidate);
    for (const chunk of chunks) {
      if (failed) break;
      decoder.decode(chunk);
    }
    if (!failed) await decoder.flush();
  } catch (err) {
    failed = err;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
  return failed ? null : performance.now() - t;
}

async function preferredMode(config, frames, makeChunks) {
  const key = fingerprint(config);
  const known = preferences.get(key);
  if (known) return known.mode;
  if (probing.has(key)) return probing.get(key);
  const run = (async () => {
    const chunks = makeChunks();
    let mode = "no-preference", hwMs = null, swMs = null;
    if (chunks.length) {
      hwMs = await timeDecode(config, "prefer-hardware", chunks);
      swMs = await timeDecode(config, "prefer-software", chunks);
      if (hwMs !== null && swMs !== null) mode = hwMs <= swMs * HW_TIE_MARGIN ? "prefer-hardware" : "prefer-software";
      else if (hwMs !== null) mode = "prefer-hardware";
      else if (swMs !== null) mode = "prefer-software";
    }
    preferences.set(key, { mode, hwMs, swMs, frames: chunks.length, demoted: false });
    const ms = (v) => (v === null ? "unavailable" : `${Math.round(v)} ms`);
    console.log(`[rde] decode probe ${key}: hardware ${ms(hwMs)} vs software ${ms(swMs)}` +
      ` over ${chunks.length} frames → ${mode}`);
    return mode;
  })();
  probing.set(key, run);
  try { return await run; } finally { probing.delete(key); }
}

/// A clip that failed in hardware and then succeeded in software — evidence
/// that the decoder, not the file, is the problem. Only that combination counts:
/// camera files do get damaged, and a clip that fails both ways says nothing
/// about the decoder. Demote the codec only once it keeps happening, so one bad
/// file cannot cost every later clip its hardware path.
const HW_FAILURE_LIMIT = 3;
function noteHardwareFailure(config) {
  const key = fingerprint(config);
  const known = preferences.get(key) || { mode: "no-preference" };
  const failures = (known.failures || 0) + 1;
  const demoted = failures >= HW_FAILURE_LIMIT;
  preferences.set(key, {
    ...known, failures,
    ...(demoted ? { mode: "prefer-software", demoted: true } : {}),
  });
  console.warn(`[rde] ${key}: hardware decode failed where software succeeded` +
    ` (${failures}/${HW_FAILURE_LIMIT})` + (demoted ? " — switching this codec to software" : ""));
}

/// What the probe decided and what it measured, for the benchmark dump — the
/// numbers behind a surprising choice matter more than the choice.
export function decodePreferences() {
  return [...preferences].map(([codec, v]) => ({ codec, ...v }));
}

/// Wait for the decoder to work through its backlog.
function drain(decoder) {
  return new Promise((resolve) => {
    const done = () => {
      if (decoder.decodeQueueSize < QUEUE_HIGH_WATER / 2) {
        decoder.removeEventListener("dequeue", done);
        resolve();
      }
    };
    decoder.addEventListener("dequeue", done);
  });
}
