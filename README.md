# RocksBeGone

Review and remove **repeat detections** (stationary boxes) in MegaDetector results — rocks, branches, grass stems, and other things that keep getting detected as animals.

RocksBeGone groups detections that recur at the same location, let you review each group, and exports a cleaned MegaDetector results file.

Everything runs in your browser. **Your results, images, videos, and metadata stay on your machine.**

It is based on MegaDetector's [Repeat Detection Elimination (RDE)](https://github.com/agentmorris/MegaDetector/tree/main/megadetector/postprocessing/repeat_detection_elimination). See [lila.science/repeat-detection-elimination](https://lila.science/repeat-detection-elimination) for an introduction to the workflow.

## Use RocksBeGone

### Hosted

Open **https://rocksbegone.camtra.pw**.

The site only provides the application. Media you select is read and processed locally by your browser and is not uploaded to the server.

### Local

Download a release, unzip it, and run `rocksbegone`.

It starts a small local server and opens RocksBeGone in your browser. The server is needed because browsers cannot run all required WebAssembly and media APIs directly from a `file://` page.

## Host it yourself

Serve the release's `web/` directory from any static web server over **HTTPS**. Video decoding requires a secure browser context.

## Build from source

Requires Rust and [wasm-pack](https://drager.github.io/wasm-pack/).

```bash
cd web
wasm-pack build --release --target web --out-dir pkg
```

Then serve `web/` with any static web server.

`rde-core` contains the RDE algorithm with no browser or I/O dependencies; `web/` contains the browser reviewer.

[SPEC.md](SPEC.md) is the design record the code's `SPEC §N` comments refer to.

## Differences from MegaDetector RDE

**Video support.** RocksBeGone supports MegaDetector video results and decodes only the frames needed for review in the browser, so videos and still images can be reviewed together without pre-extracting frames.

**Occurrence counts distinct media.** A video clip with 30 matching frames counts as one occurrence, not 30. For still-image datasets, this is effectively the same as upstream RDE.
