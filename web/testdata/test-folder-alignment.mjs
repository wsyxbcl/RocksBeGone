// Does the picked folder get aligned to the json's paths? (SPEC §6.2)
//
//   node web/testdata/test-folder-alignment.mjs
//
// This drives the REAL `media-worker.js` — the browser globals it touches at
// import time are stubbed and a File System Access directory handle is faked
// over a temp folder, but the alignment code under test is the shipped code.
//
// It exists because the alignment has no other coverage: `rde-core`'s
// `match_paths` is what the `webkitdirectory` browsers use, while Chromium goes
// through `detectOffset` here, and the two are different algorithms with
// different failure modes. A wrong answer shows up as blank crops much later,
// which is the most expensive kind of bug this tool has.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

globalThis.self = {
  location: { href: "http://localhost/media-worker.js?v=test" },
  postMessage: () => {},
};
globalThis.OffscreenCanvas = class {};
globalThis.createImageBitmap = async () => ({});

let fsCalls = 0;
function dirHandle(path, name) {
  return {
    kind: "directory", name,
    async getDirectoryHandle(child) {
      fsCalls++;
      if (!statSync(join(path, child), { throwIfNoEntry: false })?.isDirectory()) throw new Error("NotFound");
      return dirHandle(join(path, child), child);
    },
    async getFileHandle(child) {
      fsCalls++;
      if (!statSync(join(path, child), { throwIfNoEntry: false })?.isFile()) throw new Error("NotFound");
      return { kind: "file", name: child, async getFile() { return { name: child }; } };
    },
    async *entries() {
      for (const e of readdirSync(path, { withFileTypes: true })) {
        fsCalls++;
        yield [e.name, e.isDirectory() ? dirHandle(join(path, e.name), e.name) : { kind: "file", name: e.name }];
      }
    },
  };
}

const workerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "media-worker.js");
await import(workerPath);
const onmessage = globalThis.self.onmessage;

const root = mkdtempSync(join(tmpdir(), "rbg-align-"));
const touch = (rel) => { mkdirSync(join(root, dirname(rel)), { recursive: true }); writeFileSync(join(root, rel), ""); };

// A camera-trap archive as they actually arrive: a media root two levels down,
// camera folders under it, and a decoy sibling holding sidecars only.
for (const cam of ["cam_a", "cam_b"]) {
  for (const n of ["0001", "0002"]) touch(`survey/aligned/media/${cam}/${cam}-IMG_${n}.jpg`);
  touch(`survey/decoy/${cam}/${cam}-IMG_0001.jpg.xmp`);
}
// A second full copy, for the ambiguity case.
for (const cam of ["cam_a", "cam_b"]) {
  for (const n of ["0001", "0002"]) touch(`twin/backup/${cam}/${cam}-IMG_${n}.jpg`);
  for (const n of ["0001", "0002"]) touch(`twin/working/${cam}/${cam}-IMG_${n}.jpg`);
}
// Buried deeper than the search is allowed to go, in its own subtree so nothing
// else can satisfy the probe first.
for (const cam of ["cam_a", "cam_b"]) {
  for (const n of ["0001", "0002"]) touch(`deep/l1/l2/l3/${cam}/${cam}-IMG_${n}.jpg`);
}

const SAMPLES = ["cam_a/cam_a-IMG_0001.jpg", "cam_b/cam_b-IMG_0002.jpg"];

async function align(rootPath, rootName, samples = SAMPLES) {
  fsCalls = 0;
  let answer = null;
  globalThis.self.postMessage = (m) => { if (!m.progress) answer = m; };
  await onmessage({ data: { id: 1, kind: "setRoot", rootHandle: dirHandle(rootPath, rootName), samplePaths: samples } });
  return { ...answer, fsCalls };
}

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failed++;
};

// The folder the paths are relative to: no descent, and cheap.
let r = await align(join(root, "survey/aligned/media"), "media");
check("exact folder resolves", r.ok && r.hits === 2 && !r.prefix.length, `${r.fsCalls} fs calls`);
check("exact folder stays cheap", r.fsCalls < 40, `${r.fsCalls} fs calls`);

// One level above — the case that used to fail outright.
r = await align(join(root, "survey/aligned"), "aligned");
check("one level above descends", r.ok && r.hits === 2 && r.prefix.join("/") === "media", `prefix=${r.prefix}`);

// Two levels above, past a decoy that shares the camera folder names.
r = await align(join(root, "survey"), "survey");
check("two levels above descends", r.ok && r.hits === 2 && r.prefix.join("/") === "aligned/media", `prefix=${r.prefix}`);
check("decoy of sidecars rejected", r.prefix[0] !== "decoy");
check("descent stays bounded", r.fsCalls < 500, `${r.fsCalls} fs calls`);

// Three unmentioned levels is past MAX_DESCENT_DEPTH: fail, and fail fast.
// Better to say "not here" than to walk an entire drive looking.
r = await align(join(root, "deep"), "deep");
check("beyond max depth fails", !r.ok);
check("failure is fast", r.fsCalls < 500, `${r.fsCalls} fs calls`);

// Two equally good copies must be reported, not silently chosen between.
r = await align(join(root, "twin"), "twin");
check("ambiguity is reported", r.ok && Array.isArray(r.tiedWith) && r.tiedWith.length === 2,
  r.tiedWith ? r.tiedWith.map((p) => p.join("/")).join(" vs ") : "nothing reported");

// A folder with none of the media.
r = await align(join(root, "survey/decoy"), "decoy");
check("unrelated folder fails", !r.ok);

rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
