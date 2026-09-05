//! Algorithm ablation: which RDE knobs earn their keep, **on your data**.
//!
//! Every parameter here was inherited from upstream's defaults. This measures
//! what each one actually contributes on a dataset that a human has already
//! reviewed, so the answer is evidence rather than inheritance.
//!
//!     cargo run --release --example ablation -- <pre.json> <post.json> [--levels N]
//!
//! `pre.json` is the MegaDetector output; `post.json` is the same file after a
//! human RDE pass, where a confirmed repeat is marked by **negating its
//! confidence** (the upstream convention). That negated set is the label.
//!
//! ## The one thing this cannot measure, and why
//!
//! A human only ever saw the candidates that ONE configuration proposed. A
//! looser setting will propose detections nobody ever labelled, and scoring
//! those as "not a repeat" would punish it for work it was never judged on.
//!
//! So everything is scored inside the **reviewed universe** — the candidates the
//! reference configuration proposed, the only detections with a real label. For
//! each configuration we also report how much of its output falls *outside* that
//! universe, which is honest unlabelled work, not a mistake. To lift that limit
//! you would have to review a sample from a deliberately permissive run.

use std::collections::HashSet;

use rde_core::{find_suspicious, MdDocument, RdeOptions};

/// Detections a human confirmed as repeats: conf < 0 in the reviewed file.
fn removed_set(post: &serde_json::Value) -> HashSet<(usize, usize)> {
    let mut out = HashSet::new();
    let images = post.get("images").and_then(|v| v.as_array()).expect("post.images");
    for (image_index, image) in images.iter().enumerate() {
        let Some(dets) = image.get("detections").and_then(|v| v.as_array()) else { continue };
        for (detection_index, det) in dets.iter().enumerate() {
            if det.get("conf").and_then(|c| c.as_f64()).unwrap_or(0.0) < 0.0 {
                out.insert((image_index, detection_index));
            }
        }
    }
    out
}

/// Candidates when the occurrence threshold counts INSTANCES rather than
/// distinct media. Upstream's mosaic filenames are keyed on `len(instances)`,
/// so the two readings of "occurrence" are worth telling apart: a location seen
/// 30 times across 5 images passes one and fails the other.
fn proposed_by_instances(doc: &MdDocument, opts: &RdeOptions, min: usize) -> HashSet<(usize, usize)> {
    let loose = RdeOptions { occurrence_threshold: 2, ..opts.clone() };
    find_suspicious(doc, &loose)
        .iter()
        .filter(|g| g.instances.len() >= min)
        .flat_map(|g| g.instances.iter())
        .map(|i| (i.det_ref.image_index, i.det_ref.detection_index))
        .collect()
}

fn proposed(doc: &MdDocument, opts: &RdeOptions) -> HashSet<(usize, usize)> {
    find_suspicious(doc, opts)
        .iter()
        .flat_map(|g| g.instances.iter())
        .map(|i| (i.det_ref.image_index, i.det_ref.detection_index))
        .collect()
}

struct Row {
    name: String,
    proposed: usize,
    hit: usize,      // proposed AND confirmed repeat, inside the universe
    scored: usize,   // proposed AND inside the universe
    outside: usize,  // proposed but never labelled
    caught: usize,   // proposed AND confirmed repeat, ANYWHERE
    missed: usize,   // confirmed repeat this config would NOT show
}

fn score(name: &str, set: &HashSet<(usize, usize)>, universe: &HashSet<(usize, usize)>,
         removed: &HashSet<(usize, usize)>) -> Row {
    let scored: HashSet<_> = set.intersection(universe).copied().collect();
    Row {
        name: name.to_string(),
        proposed: set.len(),
        hit: scored.iter().filter(|k| removed.contains(k)).count(),
        scored: scored.len(),
        outside: set.difference(universe).count(),
        // Recall needs no universe: every confirmed repeat is a positive a human
        // actually marked, whether or not the reference config would show it.
        // Restricting recall to the universe caps it at |removed n universe| and
        // makes every looser configuration look identical.
        caught: removed.intersection(set).count(),
        missed: removed.difference(set).count(),
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let pre_path = args.next().expect("usage: ablation <pre.json> <post.json> [--levels N]");
    let post_path = args.next().expect("usage: ablation <pre.json> <post.json> [--levels N]");
    let mut levels = 1usize;
    // The occurrence threshold the LABELS were produced at, which is what defines
    // the reviewed universe. Deduced, not assumed: if the human had only seen an
    // occurrence-20 run, every detection they marked would lie inside it and
    // `missed` at 20 would be ~0. It is thousands, while at 2 it is ~100 — so the
    // review covered essentially the whole clustering.
    let mut universe_occ = 2usize;
    let rest: Vec<String> = args.collect();
    for pair in rest.windows(2) {
        if pair[0] == "--levels" { levels = pair[1].parse().expect("--levels N"); }
        if pair[0] == "--universe" { universe_occ = pair[1].parse().expect("--universe N"); }
    }

    let doc = MdDocument::from_slice(&std::fs::read(&pre_path).expect("read pre"))
        .expect("parse pre");
    let post: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&post_path).expect("read post")).expect("parse post");
    let removed = removed_set(&post);

    // The configuration the human actually reviewed under.
    let reference = RdeOptions { n_dir_levels_from_leaf: levels, ..Default::default() };
    // Everything the reviewer could have been shown — the only detections whose
    // absence from the removed set means "a human looked and kept it".
    let universe = proposed(&doc, &RdeOptions {
        occurrence_threshold: universe_occ,
        ..reference.clone()
    });
    let default_set = proposed(&doc, &reference);
    let labelled_repeats = removed.intersection(&universe).count();

    println!("{}", pre_path);
    println!("  {} media, {} detections", doc.images().len(), doc.total_detections());
    println!("  human confirmed {} repeats", removed.len());
    println!("  reviewed universe (occurrence >= {}): {} candidates, {} confirmed repeats, \
              {} kept",
             universe_occ, universe.len(), labelled_repeats, universe.len() - labelled_repeats);
    println!("  default config (occurrence >= {}) proposes {}",
             reference.occurrence_threshold, default_set.len());
    let outside_universe = removed.difference(&universe).count();
    println!("  {} confirmed repeats fall outside even that universe — the residual \
              disagreement between our clustering and the one that made these labels ({:.2}%)",
             outside_universe, outside_universe as f64 / removed.len() as f64 * 100.0);
    println!();

    // Each ablation turns ONE thing off relative to the reference.
    let wide = RdeOptions { confidence_min: 0.0, confidence_max: 1.0, ..reference.clone() };
    let mut rows = vec![score("default", &default_set, &universe, &removed)];
    let ablations: Vec<(String, RdeOptions)> = vec![
        ("no camera grouping".into(), RdeOptions { n_dir_levels_from_leaf: 0, ..reference.clone() }),
        ("category-agnostic".into(), RdeOptions { category_agnostic: true, ..reference.clone() }),
        ("no confidence band".into(), wide.clone()),
        ("no box-area band".into(),
         RdeOptions { min_suspicious_size: 0.0, max_suspicious_size: 1.0, ..reference.clone() }),
        ("no filters at all".into(),
         RdeOptions { min_suspicious_size: 0.0, max_suspicious_size: 1.0,
                      confidence_min: 0.0, confidence_max: 1.0, ..reference.clone() }),
    ];
    for (name, opts) in &ablations {
        rows.push(score(name, &proposed(&doc, opts), &universe, &removed));
    }
    for iou in [0.95f32, 0.9, 0.85, 0.8, 0.7, 0.5] {
        let opts = RdeOptions { iou_threshold: iou, ..reference.clone() };
        rows.push(score(&format!("iou {iou:.2}"), &proposed(&doc, &opts), &universe, &removed));
    }
    for occ in [2usize, 5, 10, 20, 50, 100] {
        let opts = RdeOptions { occurrence_threshold: occ, ..reference.clone() };
        rows.push(score(&format!("occurrence >= {occ}"), &proposed(&doc, &opts), &universe, &removed));
    }
    for occ in [10usize, 20, 50] {
        let set = proposed_by_instances(&doc, &reference, occ);
        rows.push(score(&format!("{occ}+ instances"), &set, &universe, &removed));
    }

    println!("{:<22} {:>9} {:>9} {:>7} {:>7} {:>9}", "configuration", "proposed", "unlabelled",
             "prec", "recall", "missed");
    for r in &rows {
        let prec = if r.scored > 0 { r.hit as f64 / r.scored as f64 } else { f64::NAN };
        let recall = if !removed.is_empty() { r.caught as f64 / removed.len() as f64 } else { f64::NAN };
        println!("{:<22} {:>9} {:>9} {:>6.1}% {:>6.1}% {:>9}",
                 r.name, r.proposed, r.outside, prec * 100.0, recall * 100.0, r.missed);
    }
    println!("\nprecision is scored only inside the reviewed universe (the only detections with a \
              label);\nrecall is over every confirmed repeat; `unlabelled` is work a config \
              proposes that nobody judged.");
}
