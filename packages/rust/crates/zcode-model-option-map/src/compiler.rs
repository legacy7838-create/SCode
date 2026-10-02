//! Compiler entry points mirroring `packages/model-option-map/src/compiler.ts`.
//!
//! The TS version caches programs by source; the cache is an optimisation that
//! does not change semantics, so the Rust port evaluates straight. Callers that
//! compile once per model (the TS call sites) pay a single parse.

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

pub fn compile_model_option_map(
    source: &str,
    variable_name: ModelOptionName,
) -> Result<ModelOptionMapProgram, RestrictedCelError> {
    let program = compile_restricted_cel(source, variable_name)?;
    if !program.expression.is_object_result() {
        // TS walks the AST and rejects any non-object branch before evaluation;
        // offsets are best-effort in Rust and point at the root expression.
        return Err(RestrictedCelError::new(
            "model option map must return a JSON object".into(),
            program.expression.offset(),
        ));
    }
    Ok(ModelOptionMapProgram {
        source: program.source,
        expression: program.expression,
    })
}
