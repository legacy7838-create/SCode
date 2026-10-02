//! Error types ported from `packages/model-option-map/src/types.ts`.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelOptionName {
    ReasoningLevel,
    MaxOutputTokens,
}

impl ModelOptionName {
    pub fn as_str(&self) -> &'static str {
        match self {
            ModelOptionName::ReasoningLevel => "reasoningLevel",
            ModelOptionName::MaxOutputTokens => "maxOutputTokens",
        }
    }
}

impl std::str::FromStr for ModelOptionName {
    type Err = RestrictedCelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "reasoningLevel" => Ok(ModelOptionName::ReasoningLevel),
            "maxOutputTokens" => Ok(ModelOptionName::MaxOutputTokens),
            other => Err(RestrictedCelError::new(
                format!("unknown model option name {other:?}"),
                0,
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestrictedCelError {
    pub message: String,
    pub offset: usize,
}

impl RestrictedCelError {
    pub fn new(message: String, offset: usize) -> Self {
        Self { message, offset }
    }
}

impl fmt::Display for RestrictedCelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at offset {}", self.message, self.offset)
    }
}

impl std::error::Error for RestrictedCelError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelOptionMapError {
    pub message: String,
}

impl fmt::Display for ModelOptionMapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ModelOptionMapError {}

pub fn json_is_object(value: &serde_json::Value) -> bool {
    value.is_object()
}
