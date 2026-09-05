//! Morris reviews ONE exemplar per repeated detection, not every crop. Under
//! that workflow the human cost is the number of GROUPS; the machine cost is
//! still the number of candidate crops to decode. They move in opposite
//! directions, so both are printed.
use rde_core::{find_suspicious, MdDocument, RdeOptions};

fn main() {
    let path = std::env::args().nth(1).expect("usage: exemplars <md.json>");
    let doc = MdDocument::from_slice(&std::fs::read(&path).expect("read")).expect("parse");
    println!("{:>26} {:>8} {:>12} {:>10}", "setting", "groups", "candidates", "per group");
    let show = |name: String, opts: RdeOptions| {
        let g = find_suspicious(&doc, &opts);
        let c: usize = g.iter().map(|x| x.instances.len()).sum();
        println!("{:>26} {:>8} {:>12} {:>10.1}", name, g.len(), c,
                 if g.is_empty() { 0.0 } else { c as f64 / g.len() as f64 });
    };
    for (occ, iou) in [(20usize, 0.9f32), (10, 0.9), (20, 0.85), (20, 0.8), (20, 0.7), (10, 0.8)] {
        show(format!("occurrence {occ}, iou {iou:.2}"),
             RdeOptions { occurrence_threshold: occ, iou_threshold: iou, ..Default::default() });
    }
}
