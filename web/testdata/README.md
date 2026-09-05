# Test fixtures

Generated, not committed — the media is a few MB and reproducible in seconds.
Both scripts write into `web/`, which `.gitignore` covers, and the dev server
serves them so a CDP-driven test can `fetch()` them.

| script | writes | what it is for |
|---|---|---|
| `make-review-fixture.sh` | `_test/` | A reviewable document: three camera folders of stills + clips, plus one `.avi` that WebCodecs cannot open. Drives the end-to-end review, navigation, cache and precompute tests. `PER` sets clips per camera — raise it when a test needs enough sources to finish a concurrency sweep. |
| `make-container-fixtures.sh` | `_containers/` | One clip per container/codec shape a general user might bring: B-frames, all-intra, long GOP, faststart, fragmented, QuickTime, HEVC, and an MP4 with its `stss` box surgically removed. |

The container fixtures encode **each frame's number in its own luma** (`geq=lum='N'`),
so a decoded frame proves its identity: read the centre pixel, compare to the
index requested. That avoids comparing against ffmpeg-extracted pixels, which
would fail on YUV→RGB rounding differences that are not bugs.

`h264_no_stss.mp4` is the important one. Cameras in the field write MP4s with no
`stss` box, which per ISO 14496-12 declares *every* sample a sync sample; trusting
that makes every "keyframe" a P-frame and WebCodecs rejects the chunk. 27 of 36
clips in one real camera set were like this. The fixture reproduces it without
needing that footage.

## Systems ablation

`?ablate=<flags>` forces a component off so its contribution can be measured
instead of assumed. Each of these was added on the strength of a measurement;
this is how we find out which still earn their keep and which can be deleted.

| flag | forces |
|---|---|
| `wholefile` | read each clip whole, as before byte-range reads |
| `linear` | decode the whole track instead of merged RAP ranges |
| `groupcrops` | crop only the detections asked for, not every candidate on an open clip. **Only meaningful while reviewing** — during precompute the caller already passes every candidate, so this switch does nothing there. |
| `software` | skip the hardware/software decode probe |

Comma-separate them, and **always pin `?concurrency=N` alongside** — comparing
runs at different concurrency is what made two of our own benchmarks
incomparable. Same document, same first-N media, one variable at a time.
`__rdeBench.dump()` records `ablated` and `backgroundConcurrency` so a dump says
which configuration produced it.

Delete a component only if it fails to help in **any** environment measured —
storage latency differs enough between a laptop SSD and a network share that one
machine is not evidence.
