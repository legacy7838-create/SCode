//! Compiler entry points mirroring `packages/model-option-map/src/compiler.ts`.
//!
//! The TS version caches programs by source; the cache is an optimisation that
//! does not change semantics, so the Rust port evaluates straight. Callers that
//! compile once per model (the TS call sites) pay a single parse.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::evaluator;
use crate::parser::{self, Expression};
use crate::tokenizer;
use crate::types::{ModelOptionName, RestrictedCelError};

/// Compiled program: evaluates to a JSON value for a string|number input.
pub struct RestrictedCelProgram {
    pub source: String,
    expression: Expression,
}

impl RestrictedCelProgram {
    pub fn evaluate(
        &self,
        input: &serde_json::Value,
    ) -> Result<serde_json::Value, RestrictedCelError> {
        evaluator::evaluate(&self.expression, input)
    }
}

/// Compiled model option map: evaluates to a JSON object.
pub struct ModelOptionMapProgram {
    pub source: String,
    expression: Expression,
}

impl ModelOptionMapProgram {
    pub fn evaluate(
        &self,
        input: &serde_json::Value,
    ) -> Result<serde_json::Map<String, serde_json::Value>, RestrictedCelError> {
        let result = evaluator::evaluate(&self.expression, input)?;
        match result {
            serde_json::Value::Object(map) => Ok(map),
            _ => Err(RestrictedCelError::new(
                "model option map must return a JSON object".into(),
                0,
            )),
        }
    }
}

pub fn compile_restricted_cel(
    source: &str,
    variable_name: ModelOptionName,
) -> Result<RestrictedCelProgram, RestrictedCelError> {
    let normalized = source.trim();
    if normalized.is_empty() {
        return Err(RestrictedCelError::new(
            "expression must not be empty".into(),
            0,
        ));
    }
    let tokens = tokenizer::tokenize(normalized)?;
    let expression = parser::parse(&tokens, variable_name)?;
    Ok(RestrictedCelProgram {
        source: normalized.to_string(),
        expression,
    })
}

/// Compiles (or returns the cached) model option map program.
///
/// The TS reference caches compiled programs by normalised source
/// (`compiler.ts`'s `optionMapCache`) — config validation compiles the same
/// ~120 maps on every decode, and the registry resolve path compiles them
/// again. The cache is a pure-function memo keyed by `(trimmed source,
/// variable)`: a hit cannot change any output, and an unbounded map mirrors
/// the TS one exactly (the keys are config-bounded, not attacker-bounded).
pub fn compile_model_option_map(
    source: &str,
    variable_name: ModelOptionName,
) -> Result<Arc<ModelOptionMapProgram>, RestrictedCelError> {
    type Cache = Mutex<HashMap<(String, &'static str), Result<Arc<ModelOptionMapProgram>, RestrictedCelError>>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let normalized = source.trim();
    let cache_key = (normalized.to_string(), variable_name.as_str());
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap();
    if let Some(hit) = guard.get(&cache_key) {
        return match hit {
            Ok(program) => Ok(Arc::clone(program)),
            Err(error) => Err(error.clone()),
        };
    }
    let built = compile_uncached(normalized, variable_name);
    if let Ok(program) = &built {
        guard.insert(cache_key, Ok(Arc::clone(program)));
    }
    built
}

fn compile_uncached(
    normalized: &str,
    variable_name: ModelOptionName,
) -> Result<Arc<ModelOptionMapProgram>, RestrictedCelError> {
    let program = compile_restricted_cel(normalized, variable_name)?;
    if !program.expression.is_object_result() {
        // TS walks the AST and rejects any non-object branch before evaluation;
        // offsets are best-effort in Rust and point at the root expression.
        return Err(RestrictedCelError::new(
            "model option map must return a JSON object".into(),
            program.expression.offset(),
        ));
    }
    Ok(Arc::new(ModelOptionMapProgram {
        source: program.source,
        expression: program.expression,
    }))
}
