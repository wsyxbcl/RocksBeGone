//! Does clustering need a spatial index? Upstream reaches for fastquadtree
//! because "comparing a million boxes to a million boxes can be slow". Ours
//! buckets by (camera, category) first and then scans that bucket's clusters
//! linearly — this measures whether that is enough at real sizes.
use rde_core::{find_suspicious, MdDocument, RdeOptions};

fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).expect("read");
        let doc = MdDocument::from_slice(&bytes).expect("parse");
        let opts = RdeOptions::default();
        let t = std::time::Instant::now();
        let groups = find_suspicious(&doc, &opts);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let dets = doc.total_detections();
        println!("{:>7} media {:>7} detections -> {:>5} groups in {:>7.1} ms  ({:.2} us/detection)",
                 doc.images().len(), dets, groups.len(), ms, ms * 1000.0 / dets as f64);
    }
}
