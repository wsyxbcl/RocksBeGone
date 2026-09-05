#!/usr/bin/env bash
# Container/codec fixtures for generality testing.
#
# Every frame's LUMA equals its own frame number (geq lum='N'), so a decoded
# frame proves its own identity: read the centre pixel, compare to the index we
# asked for. That is codec- and colour-pipeline-independent, which matters —
# ffmpeg and WebCodecs do not agree on YUV->RGB to the last bit, so comparing
# against ffmpeg-extracted pixels would fail for reasons that are not bugs.
#
# Everything here has been measured only against one camera family (avc1,
# moov-at-EOF, no stss). These cover the shapes a general user can bring.
set -eu
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_containers"
rm -rf "$DIR"; mkdir -p "$DIR"

# 120 frames, luma == frame number, at 128x96 so it stays small.
src() { echo "color=c=black:s=128x96:r=30:d=4"; }
FILTER="geq=lum='N':cb=128:cr=128,scale=in_range=full:out_range=full"
common=(-f lavfi -i "$(src)" -vf "$FILTER" -color_range pc -pix_fmt yuv420p)

# 1. Baseline: h264, real stss, B-frames, GOP 40 (presentation != decode order).
ffmpeg -loglevel error -y "${common[@]}" -c:v libx264 -crf 16 -bf 3 -g 40 "$DIR/h264_bframes.mp4"

# 2. All-intra: every frame a keyframe, so ranges are one sample long.
ffmpeg -loglevel error -y "${common[@]}" -c:v libx264 -crf 16 -g 1 "$DIR/h264_allintra.mp4"

# 3. Long GOP: forces the backwards sync walk over many samples.
ffmpeg -loglevel error -y "${common[@]}" -c:v libx264 -crf 16 -bf 2 -g 120 "$DIR/h264_longgop.mp4"

# 4. Fast-start: moov moved to the front, the layout only 6 of 36 real clips had.
ffmpeg -loglevel error -y "${common[@]}" -c:v libx264 -crf 16 -bf 3 -g 40 \
  -movflags +faststart "$DIR/h264_faststart.mp4"

# 5. Fragmented MP4: moof/mfra instead of one moov sample table.
ffmpeg -loglevel error -y "${common[@]}" -c:v libx264 -crf 16 -g 40 \
  -movflags frag_keyframe+empty_moov+default_base_moof "$DIR/h264_fragmented.mp4"

# 6. HEVC: the other branch of the sync-repair NAL walk (IRAP 16-23 vs IDR 5).
ffmpeg -loglevel error -y "${common[@]}" -c:v libx265 -crf 20 -g 40 \
  -tag:v hvc1 "$DIR/hevc_hvc1.mp4"

# 7. QuickTime container rather than mp4.
ffmpeg -loglevel error -y "${common[@]}" -c:v libx264 -crf 16 -bf 3 -g 40 "$DIR/h264.mov"

# 8. The camera case: P-frames but NO stss box, so the container calls every
#    sample a sync sample. ffmpeg will not write that, so strip the box and
#    correct the parent sizes by hand.
ffmpeg -loglevel error -y "${common[@]}" -c:v libx264 -crf 16 -bf 0 -g 30 "$DIR/_tmp_stss.mp4"
python3 - "$DIR/_tmp_stss.mp4" "$DIR/h264_no_stss.mp4" <<'PY'
import struct, sys
data = bytearray(open(sys.argv[1], "rb").read())

def walk(buf, start, end, path=()):
    p = start
    while p + 8 <= end:
        size, typ = struct.unpack_from(">I4s", buf, p)
        typ = typ.decode("latin1")
        if size == 1:
            size = struct.unpack_from(">Q", buf, p + 8)[0]
        if size < 8 or p + size > end:
            return
        yield path + (typ,), p, size
        if typ in ("moov", "trak", "mdia", "minf", "stbl"):
            yield from walk(buf, p + 8, p + size, path + (typ,))
        p += size

boxes = list(walk(data, 0, len(data)))
stss = [(p, size) for path, p, size in boxes if path[-1] == "stss"]
if not stss:
    raise SystemExit("no stss to remove — nothing to test")
at, size = stss[0]
# Shrink every ancestor that contains it, then cut the box out.
for path, p, bsize in boxes:
    if p < at < p + bsize and path[-1] != "stss":
        struct.pack_into(">I", data, p, bsize - size)
del data[at:at + size]
open(sys.argv[2], "wb").write(data)
print(f"  stripped stss ({size} B) -> {sys.argv[2].split('/')[-1]}")
PY
rm -f "$DIR/_tmp_stss.mp4"

ls -la "$DIR" | awk 'NR>3 {printf "  %-24s %6.1f KB\n", $9, $5/1024}'
