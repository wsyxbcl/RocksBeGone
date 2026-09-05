//! Ambiguity-safe path matching (SPEC §6.2). Camera-trap datasets reuse
//! filenames heavily (`IMG_0001.JPG` under many camera folders), so a basename
//! fallback can silently show the wrong image. The rule: match a json `file`
//! path to a picked file path by the **longest suffix** (component-wise) that is
//! **unique** among the picked files; never guess an ambiguous one.
//!
//! This is pure logic (json paths + picked paths in, decisions out), so it lives
//! in the core and is tested natively; the browser only gathers the picked
//! paths (`webkitRelativePath`) and passes them in.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// The outcome of matching one json path against the picked files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum PathMatch {
    /// Exactly one picked file has the longest matching suffix.
    Matched { picked_index: usize },
    /// No picked file shares even the basename.
    Unmatched,
    /// Several picked files tie for the longest suffix — do not guess.
    Ambiguous,
}

/// Match each `json_paths[i]` to a `picked_paths` index (SPEC §6.2), in order.
pub fn match_paths(json_paths: &[String], picked_paths: &[String]) -> Vec<PathMatch> {
    let picked_components: Vec<Vec<&str>> =
        picked_paths.iter().map(|p| components(p)).collect();

    // Bucket picked files by basename; a shared suffix requires a shared basename.
    let mut by_basename: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, comps) in picked_components.iter().enumerate() {
        if let Some(basename) = comps.last() {
            by_basename.entry(basename).or_default().push(index);
        }
    }

    json_paths
        .iter()
        .map(|json_path| {
            let json_components = components(json_path);
            let Some(basename) = json_components.last() else {
                return PathMatch::Unmatched;
            };
            let Some(candidates) = by_basename.get(basename) else {
                return PathMatch::Unmatched;
            };

            // Longest common suffix among same-basename candidates.
            let mut best_len = 0usize;
            let mut best: Vec<usize> = Vec::new();
            for &candidate in candidates {
                let len = common_suffix_len(&json_components, &picked_components[candidate]);
                if len > best_len {
                    best_len = len;
                    best.clear();
                    best.push(candidate);
                } else if len == best_len {
                    best.push(candidate);
                }
            }

            if best_len >= 1 && best.len() == 1 {
                PathMatch::Matched {
                    picked_index: best[0],
                }
            } else {
                PathMatch::Ambiguous
            }
        })
        .collect()
}

/// Non-empty path components, separator-agnostic ('/' or '\').
fn components(path: &str) -> Vec<&str> {
    path.split(['/', '\\']).filter(|s| !s.is_empty()).collect()
}

/// Number of trailing components that are equal.
fn common_suffix_len(a: &[&str], b: &[&str]) -> usize {
    a.iter()
        .rev()
        .zip(b.iter().rev())
        .take_while(|(x, y)| x == y)
        .count()
}
