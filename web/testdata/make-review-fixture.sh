#!/usr/bin/env bash
# Rebuild web/_test: the regression fixture the verify_*.mjs scripts drive.
# Deliberately mixed: stills + h264 clips + one container WebCodecs cannot open,
# so a run exercises the image path, the decode path and the failure path at once.
#
# Files stay flat on disk (CDP cannot populate a webkitdirectory input), but the
# json puts them under three camera folders — folder matching keys off the
# basename, and the camera comes from the json path. That is what gives several
# groups to navigate between.
#
# Delete the directory again before committing — it is generated media.
set -eu
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_test"
CAMS=(cam_a cam_b cam_c)
PER=8
rm -rf "$DIR"; mkdir -p "$DIR"

for c in "${!CAMS[@]}"; do
  for i in $(seq 1 $PER); do
    magick -size 640x480 xc:gray30 -fill "#8a6" -draw "rectangle 200,150 280,240" \
      -fill white -pointsize 28 -draw "text 20,40 '${CAMS[$c]} $i'" "$DIR/img_${c}_$i.jpg"
    # 10 fps, 60 frames, keyframe every 20 -> frames 0/25/50 span three GOPs
    ffmpeg -loglevel error -y -f lavfi -i "testsrc=size=640x480:rate=10:duration=6" \
      -c:v libx264 -g 20 -pix_fmt yuv420p "$DIR/clip_${c}_$i.mp4"
  done
done

# The unsupported-container case: mpeg4 in avi, which WebCodecs refuses.
ffmpeg -loglevel error -y -f lavfi -i "testsrc=size=640x480:rate=10:duration=2" \
  -c:v mpeg4 -q:v 5 "$DIR/legacy_01.avi"

python3 - "$DIR" "$PER" "${CAMS[@]}" <<'PY'
import json, sys, pathlib
d, per, cams = pathlib.Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
box = [0.31, 0.31, 0.13, 0.19]          # identical box -> IoU 1.0 -> one cluster
images = []
for c, cam in enumerate(cams):
    for i in range(1, per + 1):
        images.append({"file": f"_test/{cam}/img_{c}_{i}.jpg",
                       "detections": [{"category": "1", "conf": 0.42, "bbox": box}]})
        images.append({"file": f"_test/{cam}/clip_{c}_{i}.mp4", "frame_rate": 10.0,
                       "frames_processed": [0, 25, 50],
                       "detections": [{"category": "1", "conf": 0.44, "bbox": box,
                                       "frame_number": f} for f in (0, 25, 50)]})
images.append({"file": f"_test/{cams[0]}/legacy_01.avi", "frame_rate": 10.0,
               "frames_processed": [0],
               "detections": [{"category": "1", "conf": 0.44, "bbox": box,
                               "frame_number": 0}]})
(d / "mixed_e2e.json").write_text(json.dumps({
    "info": {"detector": "megadetector_v5a", "note": "RocksBeGone regression fixture"},
    "detection_categories": {"1": "animal", "2": "person", "3": "vehicle"},
    "images": images}, indent=1))
print(f"{len(images)} media across {len(cams)} cameras -> {d/'mixed_e2e.json'}")
PY
ls "$DIR" | wc -l
