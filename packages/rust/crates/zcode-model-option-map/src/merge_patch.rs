//! JSON merge-patch application with conflict detection.
//!
//! Port of `packages/model-option-map/src/merge-patch.ts`: two option maps may
//! not write overlapping JSON paths; empty objects patch values rather than
//! recursing (an empty object still "owns" its path), and a `null` patch value
//! deletes the key.

use crate::types::ModelOptionMapError;

pub struct NamedJsonMergePatch {
    pub option: String,
    pub patch: serde_json::Map<String, serde_json::Value>,
}

pub fn apply_ordered_json_merge_patches(
    body: &serde_json::Map<String, serde_json::Value>,
    patches: &[NamedJsonMergePatch],
) -> Result<serde_json::Map<String, serde_json::Value>, ModelOptionMapError> {
    let mut owned_paths: Vec<(String, Vec<String>)> = Vec::new();
    let mut result = body.clone();
    for named_patch in patches {
        let paths = collect_written_paths(&named_patch.patch, &[]);
        for path in &paths {
            if let Some((conflict_option, _)) = owned_paths
                .iter()
                .find(|(_, owned)| paths_overlap(owned, path))
            {
                return Err(ModelOptionMapError {
                    message: format!(
                        "Model option maps write conflicting JSON path {}: {} and {}",
                        format_path(path),
                        conflict_option,
                        named_patch.option
                    ),
                });
            }
            owned_paths.push((named_patch.option.clone(), path.clone()));
        }
        merge_object(&mut result, &named_patch.patch);
    }
    Ok(result)
}

fn collect_written_paths(
    patch: &serde_json::Map<String, serde_json::Value>,
    prefix: &[String],
) -> Vec<Vec<String>> {
    let mut paths = Vec::new();
    for (key, value) in patch {
        let mut path = prefix.to_vec();
        path.push(key.clone());
        match value {
            serde_json::Value::Object(child) if !child.is_empty() => {
                paths.extend(collect_written_paths(child, &path));
            }
            _ => paths.push(path),
        }
    }
    paths
}

fn paths_overlap(left: &[String], right: &[String]) -> bool {
    let shared = left.len().min(right.len());
    left[..shared] == right[..shared]
}

fn format_path(path: &[String]) -> String {
    if path.is_empty() {
        return "$".to_string();
    }
    format!("$.{}", path.join("."))
}

fn merge_object(
    target: &mut serde_json::Map<String, serde_json::Value>,
    patch: &serde_json::Map<String, serde_json::Value>,
) {
    for (key, patch_value) in patch {
        match patch_value {
            serde_json::Value::Null => {
                target.remove(key);
            }
            serde_json::Value::Object(child) => {
                let entry = target
                    .entry(key.clone())
                    .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
                match entry {
                    serde_json::Value::Object(map) => merge_object(map, child),
                    replaced => {
                        *replaced = serde_json::Value::Object(serde_json::Map::new());
                        merge_object(replaced.as_object_mut().unwrap(), child);
                    }
                }
            }
            other => {
                target.insert(key.clone(), other.clone());
            }
        }
    }
}
