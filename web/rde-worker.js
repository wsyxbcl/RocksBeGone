// RDE worker (SPEC §5.1): all Rust/WASM work — MD json parse, clustering, and
// the export mask — runs here, off the UI thread. Communication is an id-keyed
// request/response over structured-clone messages; only bytes and small JSON
// DTOs cross the boundary (never shared pointers).

// Cache-busting has to reach the worker's *imports*, not just the worker: a
// versioned worker URL paired with a stale cached wasm glue is how you get
// "session.<new method> is not a function". Import dynamically with this
// worker's own ?v=, so bumping BUILD in index.html invalidates the whole graph.
const BUILD = new URL(self.location.href).searchParams.get("v") || "dev";

const ready = (async () => {
  const wasm = await import(`./pkg/rocksbegone.js?v=${BUILD}`);
  // The binary needs the version too. Left to itself the glue resolves
  // `new URL("rocksbegone_bg.wasm", import.meta.url)`, which DROPS the query — so a
  // fresh glue would load a stale cached .wasm and every new export would fail
  // as `wasm.<name> is not a function`. Hand it an explicit versioned URL.
  await wasm.default({ module_or_path: new URL(`./pkg/rocksbegone_bg.wasm?v=${BUILD}`, self.location.href) });
  return wasm;
})();
let session = null;

self.onmessage = async (event) => {
  const { id, type } = event.data;
  try {
    const { RdeSession, default_options, match_paths, version } = await ready;
    switch (type) {
      // The release number, straight from the binary. The page has no other way
      // to know it — a static file cannot read Cargo.toml — and a second copy in
      // the HTML is a second thing to forget to bump.
      case "version": return reply(id, { version: version() });
      case "load": {
        // `bytes` arrives as a transferred ArrayBuffer (zero-copy, SPEC §2.1).
        const t = performance.now();
        session = new RdeSession(new Uint8Array(event.data.bytes));
        console.log(`[rde/worker] parse: ${Math.round(performance.now() - t)} ms`);
        reply(id, {
          imageCount: session.image_count(),
          totalDetections: session.total_detections(),
          defaultOptions: default_options(),
          imageFiles: session.image_files(), // json paths, for path diagnostics + matching
          videoFrameRates: session.video_frame_rates(), // [[image_index, fps], …] (SPEC §2.2)
          categoryNames: session.category_names(),     // {"1":"animal", …}, for preview labels
        });
        break;
      }
      case "detections": {
        requireSession();
        // Cheap enough to fetch per preview; the review UI is idle here anyway.
        reply(id, { detections: session.detections_of(event.data.imageIndex) });
        break;
      }
      case "find": {
        requireSession();
        const t = performance.now();
        // find() returns a JSON string; keep it a string across the boundary.
        const groups = session.find(event.data.options);
        console.log(`[rde/worker] cluster: ${Math.round(performance.now() - t)} ms`);
        reply(id, { groups });
        break;
      }
      case "match": {
        requireSession();
        const t = performance.now();
        // Resolve json image paths to the picked files (SPEC §6.2). The json
        // paths stay inside the worker; only picked paths + results cross.
        const matches = match_paths(
          session.image_files(),
          JSON.stringify(event.data.pickedPaths),
        );
        console.log(`[rde/worker] match: ${Math.round(performance.now() - t)} ms`);
        reply(id, { matches });
        break;
      }
      case "export": {
        requireSession();
        const bytes = session.export(event.data.removeRefs);
        // Transfer the output buffer back (it's a fresh JS-owned copy).
        self.postMessage({ id, ok: true, result: { bytes } }, [bytes.buffer]);
        break;
      }
      default:
        throw new Error(`unknown message type: ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

function requireSession() {
  if (!session) throw new Error("no document loaded");
}

function reply(id, result) {
  self.postMessage({ id, ok: true, result });
}
