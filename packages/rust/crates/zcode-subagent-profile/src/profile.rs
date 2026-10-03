//! Agent-profile assembly, ported from `apps/zcode-cli/packages/core/src/subagent/profile.ts`.
//!
//! Spec: docs/specs/subagent-rust-port.md (Phase 1).
//!
//! The important rule this module encodes: a profile that declares `yield: true`
//! without a usable `outputSchema` is **rejected**, not loaded with the contract
//! silently dropped. Loading it would run an agent whose declared result contract
//! is not enforced — a silent opt-out, which the product's zero-fallback rule
//! forbids.

use serde_json::{json, Map, Value};

use crate::frontmatter::{parse_loose_frontmatter, split_markdown_frontmatter, FrontmatterValues};

const AGENT_SOURCE_PROJECT: &str = "project";

pub const DIAGNOSTIC_MISSING_FRONTMATTER: &str = "agent_missing_frontmatter";
const DIAGNOSTIC_MISSING_NAME: &str = "agent_missing_name";
const DIAGNOSTIC_MISSING_DESCRIPTION: &str = "agent_missing_description";
const DIAGNOSTIC_INVALID_MEMORY_SCOPE: &str = "agent_invalid_memory_scope";
pub const DIAGNOSTIC_INVALID_YIELD_SCHEMA: &str = "agent_invalid_yield_schema";
const DIAGNOSTIC_INVALID_MCP_SERVERS: &str = "agent_invalid_mcp_servers";

#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentProfile {
    /// The parsed frontmatter values, verbatim.
    ///
    /// Model selection is derived from `model`/`thoughtLevel` by a TypeScript helper
    /// that owns no parsing quirks (`parseSubagentMarkdownSelection`), and it consumes
    /// the raw map rather than the profile. Returning the map keeps that derivation
    /// working after the reader moved to Rust — dropping it would silently unpin the
    /// model of every agent that names one.
    pub frontmatter: FrontmatterValues,
    pub name: String,
    pub description: String,
    pub source: String,
    pub system_prompt: String,
    pub path: Option<String>,
    pub color: Option<String>,
    pub permission_mode: Option<String>,
    pub max_turns: Option<i64>,
    pub memory: Option<String>,
    /// Present only when the profile declared `yield: true` with a usable schema.
    pub yield_schema: Option<Value>,
    pub tools: Option<Vec<String>>,
    pub disallowed_tools: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub background: Option<bool>,
    pub inject_agents_md: Option<bool>,
    pub mcp_servers: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct ParseOutcome {
    /// **Index 0 is the primary diagnostic** — the back-compat `diagnostic` slot the
    /// TypeScript contract exposes. On a fatal rejection the fatal one goes first
    /// even when a non-fatal diagnostic was collected earlier, which is what the
    /// TypeScript original does (`{ diagnostic: yieldDiagnostic, diagnostics: all }`).
    /// Later entries are secondary context. A profile can carry more than one
    /// diagnostic, which the single-slot field cannot express.
    pub diagnostics: Vec<Diagnostic>,
    pub profile: Option<AgentProfile>,
}

impl ParseOutcome {
    fn rejected(diagnostic: Diagnostic) -> Self {
        ParseOutcome {
            diagnostics: vec![diagnostic],
            profile: None,
        }
    }

    /// The value shape the napi boundary returns. `diagnostic` is the back-compat
    /// single slot and always carries `diagnostics[0]`.
    pub fn to_json(&self) -> Value {
        let items: Vec<Value> = self
            .diagnostics
            .iter()
            .map(|item| json!({
                "code": item.code,
                "message": item.message,
                "path": item.path,
            }))
            .collect();
        let primary = items.first().cloned().unwrap_or(Value::Null);
        json!({
            "diagnostic": primary,
            "diagnostics": if items.is_empty() { Value::Null } else { Value::Array(items) },
            "profile": match &self.profile {
                Some(profile) => profile.to_json(),
                None => Value::Null,
            },
        })
    }
}

impl AgentProfile {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert(
            "frontmatter".into(),
            Value::Object(self.frontmatter.clone()),
        );
        map.insert("name".into(), json!(self.name));
        map.insert("description".into(), json!(self.description));
        map.insert("source".into(), json!(self.source));
        map.insert("systemPrompt".into(), json!(self.system_prompt));
        if let Some(path) = &self.path {
            map.insert("path".into(), json!(path));
        }
        if let Some(color) = &self.color {
            map.insert("color".into(), json!(color));
        }
        if let Some(mode) = &self.permission_mode {
            map.insert("permissionMode".into(), json!(mode));
        }
        if let Some(max_turns) = self.max_turns {
            map.insert("maxTurns".into(), json!(max_turns));
        }
        if let Some(memory) = &self.memory {
            map.insert("memory".into(), json!(memory));
        }
        if let Some(schema) = &self.yield_schema {
            map.insert("yield".into(), json!({ "mode": "structured", "schema": schema }));
        }
        if let Some(tools) = &self.tools {
            map.insert("tools".into(), json!(tools));
        }
        if let Some(disallowed) = &self.disallowed_tools {
            map.insert("disallowedTools".into(), json!(disallowed));
        }
        if let Some(skills) = &self.skills {
            map.insert("skills".into(), json!(skills));
        }
        if let Some(background) = self.background {
            map.insert("background".into(), json!(background));
        }
        if let Some(inject) = self.inject_agents_md {
            map.insert("injectAgentsMd".into(), json!(inject));
        }
        if let Some(servers) = &self.mcp_servers {
            map.insert("mcpServers".into(), json!(servers));
        }
        Value::Object(map)
    }
}

const VALID_MEMORY_SCOPES: [&str; 3] = ["user", "project", "local"];

const VALID_PERMISSION_MODES: [&str; 5] = [
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "ask",
];

const VALID_COLORS: [&str; 9] = [
    "red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan", "white",
];

/// Port of `parseAgentProfileFromMarkdown`.
pub fn parse_agent_profile_from_markdown(
    content: &str,
    source: &str,
    path: Option<&str>,
) -> ParseOutcome {
    let display_path = path.unwrap_or("<inline>").to_string();
    let (frontmatter_text, body) = split_markdown_frontmatter(content);
    let Some(frontmatter_text) = frontmatter_text else {
        return ParseOutcome::rejected(Diagnostic {
            code: DIAGNOSTIC_MISSING_FRONTMATTER.into(),
            message: format!("Agent Markdown must include frontmatter: {display_path}"),
            path: path.map(str::to_string),
        });
    };

    let loose = parse_loose_frontmatter(&frontmatter_text);
    let values = &loose.values;

    let Some(name) = scalar_string(values.get("name")) else {
        return ParseOutcome::rejected(Diagnostic {
            code: DIAGNOSTIC_MISSING_NAME.into(),
            message: format!("Agent Markdown must include a name: {display_path}"),
            path: path.map(str::to_string),
        });
    };
    let Some(description) = scalar_string(values.get("description")) else {
        return ParseOutcome::rejected(Diagnostic {
            code: DIAGNOSTIC_MISSING_DESCRIPTION.into(),
            message: format!("Agent Markdown must include a description: {display_path}"),
            path: path.map(str::to_string),
        });
    };
    let description = description.replace("\\n", "\n");

    // MCP server names: absent stays absent, anything malformed becomes `None`
    // (which the caller treats as a hard error) rather than an empty list.
    let mcp_servers_configured = values.contains_key("mcpServers");
    let mcp_servers_invalid = !matches!(values.get("mcpServers"), Some(Value::Array(_)))
        || loose.bare_value_keys.iter().any(|k| k == "mcpServers")
        || loose.invalid_nested_list_keys.iter().any(|k| k == "mcpServers");
    let mcp_servers: Option<Option<Vec<String>>> = if !mcp_servers_configured {
        None
    } else if mcp_servers_invalid {
        Some(None)
    } else {
        let names = values
            .get("mcpServers")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(|s| s.trim().to_string()))
                    .collect::<Vec<String>>()
            })
            .filter(|names| {
                names.len()
                    == values.get("mcpServers").and_then(Value::as_array).map(Vec::len).unwrap_or(0)
                    && names.iter().all(|name| !name.is_empty())
            });
        Some(names)
    };
    if let Some(None) = mcp_servers {
        return ParseOutcome::rejected(Diagnostic {
            code: DIAGNOSTIC_INVALID_MCP_SERVERS.into(),
            message: format!(
                "Agent frontmatter mcpServers must be a list of parent server names: {display_path}"
            ),
            path: path.map(str::to_string),
        });
    }

    let memory = values
        .get("memory")
        .and_then(|value| scalar_string(Some(value)))
        .filter(|scope| VALID_MEMORY_SCOPES.contains(&scope.as_str()));
    let memory_diagnostic = match values.get("memory") {
        Some(_) if memory.is_none() => Some(Diagnostic {
            code: DIAGNOSTIC_INVALID_MEMORY_SCOPE.into(),
            message: format!(
                "Agent frontmatter memory must be user, project, or local: {display_path}"
            ),
            path: path.map(str::to_string),
        }),
        _ => None,
    };

    // The yield contract. `yield: true` requires an object-shaped outputSchema; a
    // multiline YAML block is NOT supported because this frontmatter reader is not a
    // YAML parser, and a string is tolerated by parsing it as JSON.
    let yield_requested = matches!(values.get("yield"), Some(Value::Bool(true)));
    let mut output_schema = values.get("outputSchema").cloned();
    if let Some(Value::String(text)) = &output_schema {
        output_schema = serde_json::from_str::<Value>(text).ok();
    }
    let yield_invalid = yield_requested
        && !matches!(output_schema, Some(Value::Object(_)));
    let yield_diagnostic = if yield_invalid {
        Some(Diagnostic {
            code: DIAGNOSTIC_INVALID_YIELD_SCHEMA.into(),
            message: format!(
                "Agent frontmatter 'yield: true' requires a non-empty 'outputSchema' object: {display_path}"
            ),
            path: path.map(str::to_string),
        })
    } else {
        None
    };

    // A declared contract that cannot be enforced rejects the profile outright, and
    // that fatal diagnostic takes the primary slot.
    if yield_invalid {
        return ParseOutcome {
            diagnostics: yield_diagnostic
                .into_iter()
                .chain(memory_diagnostic)
                .collect(),
            profile: None,
        };
    }
    let diagnostics: Vec<Diagnostic> = memory_diagnostic.into_iter().collect();

    let permission_mode = scalar_string(values.get("permissionMode"))
        .filter(|mode| VALID_PERMISSION_MODES.contains(&mode.as_str()));
    // Project-scope profiles are warehouse content: they may not raise their own
    // permission mode through frontmatter.
    let permission_mode = if source == AGENT_SOURCE_PROJECT {
        None
    } else {
        permission_mode
    };

    let tools = optional_tool_list(values.get("tools"));
    let disallowed_tools = optional_tool_list(values.get("disallowedTools"));
    let skills = values
        .get("skills")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<String>>()
        })
        .filter(|list| !list.is_empty());

    let profile = AgentProfile {
        frontmatter: values.clone(),
        name,
        description,
        source: source.to_string(),
        system_prompt: body.trim().to_string(),
        path: path.map(str::to_string),
        color: scalar_string(values.get("color"))
            .filter(|color| VALID_COLORS.contains(&color.as_str())),
        permission_mode,
        max_turns: normalize_positive_integer(values.get("maxTurns")),
        memory,
        yield_schema: if yield_requested { output_schema } else { None },
        tools,
        disallowed_tools,
        skills,
        background: optional_boolean(values.get("background")),
        inject_agents_md: optional_boolean(values.get("injectAgentsMd")),
        mcp_servers: mcp_servers.flatten(),
    };

    ParseOutcome {
        diagnostics,
        profile: Some(profile),
    }
}

fn scalar_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn optional_boolean(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) => {
            if text.eq_ignore_ascii_case("true") {
                Some(true)
            } else if text.eq_ignore_ascii_case("false") {
                Some(false)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn normalize_positive_integer(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => {
            let parsed = number.as_i64()?;
            if parsed > 0 {
                Some(parsed)
            } else {
                None
            }
        }
        Value::String(text) => {
            if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) {
                let parsed = text.parse::<i64>().ok()?;
                if parsed > 0 {
                    Some(parsed)
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Mirrors `optionalList` for tool lists: an explicitly empty array stays empty
/// (that is how a profile says "no tools"), an absent or unusable value yields `None`.
fn optional_tool_list(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    let list: Vec<String> = items
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect();
    if !list.is_empty() {
        return Some(list);
    }
    Some(Vec::new())
}
