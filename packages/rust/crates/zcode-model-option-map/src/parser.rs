//! Recursive-descent parser for the restricted CEL subset.
//!
//! Faithful port of `packages/model-option-map/src/parser.ts`: same precedence,
//! same error messages and offsets. Unsupported trailing member access and
//! function calls are rejected here rather than silently parsed.

use crate::tokenizer::{Token, TokenKind};
use crate::types::{ModelOptionName, RestrictedCelError};

#[derive(Debug, Clone, PartialEq)]
pub enum Expression {
    Literal {
        value: serde_json::Value,
        offset: usize,
    },
    Input {
        offset: usize,
    },
    Array {
        elements: Vec<Expression>,
        offset: usize,
    },
    Object {
        entries: Vec<(String, Expression, usize)>,
        offset: usize,
    },
    Unary {
        operator: char,
        operand: Box<Expression>,
        offset: usize,
    },
    Binary {
        operator: String,
        left: Box<Expression>,
        right: Box<Expression>,
        offset: usize,
    },
    Conditional {
        condition: Box<Expression>,
        when_true: Box<Expression>,
        when_false: Box<Expression>,
        offset: usize,
    },
}

impl Expression {
    pub fn offset(&self) -> usize {
        match self {
            Expression::Literal { offset, .. }
            | Expression::Input { offset }
            | Expression::Array { offset, .. }
            | Expression::Object { offset, .. }
            | Expression::Unary { offset, .. }
            | Expression::Binary { offset, .. }
            | Expression::Conditional { offset, .. } => *offset,
        }
    }

    pub fn is_object_result(&self) -> bool {
        match self {
            Expression::Object { .. } => true,
            Expression::Conditional {
                when_true,
                when_false,
                ..
            } => when_true.is_object_result() && when_false.is_object_result(),
            _ => false,
        }
    }
}

pub fn parse(
    tokens: &[Token],
    variable_name: ModelOptionName,
) -> Result<Expression, RestrictedCelError> {
    let mut parser = Parser {
        tokens,
        index: 0,
        variable_name,
    };
    let expression = parser.parse_conditional()?;
    let trailing = parser.current();
    if trailing.kind != TokenKind::Eof {
        if trailing.value == "." {
            return Err(RestrictedCelError::new(
                "member access is not supported".into(),
                trailing.offset,
            ));
        }
        if trailing.value == "(" {
            return Err(RestrictedCelError::new(
                "function calls are not supported".into(),
                trailing.offset,
            ));
        }
        return Err(RestrictedCelError::new(
            format!(
                "unexpected token {}",
                serde_json::to_string(&trailing.value).unwrap_or_default()
            ),
            trailing.offset,
        ));
    }
    Ok(expression)
}

struct Parser<'a> {
    tokens: &'a [Token],
    index: usize,
    variable_name: ModelOptionName,
}

impl<'a> Parser<'a> {
    fn parse_conditional(&mut self) -> Result<Expression, RestrictedCelError> {
        let condition = self.parse_logical_or()?;
        if !self.consume("?") {
            return Ok(condition);
        }
        let when_true = self.parse_conditional()?;
        self.expect(":")?;
        let when_false = self.parse_conditional()?;
        Ok(Expression::Conditional {
            offset: condition.offset(),
            condition: Box::new(condition),
            when_true: Box::new(when_true),
            when_false: Box::new(when_false),
        })
    }

    fn parse_logical_or(&mut self) -> Result<Expression, RestrictedCelError> {
        self.parse_binary(|p| p.parse_logical_and(), &["||"])
    }
    fn parse_logical_and(&mut self) -> Result<Expression, RestrictedCelError> {
        self.parse_binary(|p| p.parse_equality(), &["&&"])
    }
    fn parse_equality(&mut self) -> Result<Expression, RestrictedCelError> {
        self.parse_binary(|p| p.parse_relational(), &["==", "!="])
    }
    fn parse_relational(&mut self) -> Result<Expression, RestrictedCelError> {
        self.parse_binary(|p| p.parse_additive(), &["<", "<=", ">", ">="])
    }
    fn parse_additive(&mut self) -> Result<Expression, RestrictedCelError> {
        self.parse_binary(|p| p.parse_multiplicative(), &["+", "-"])
    }
    fn parse_multiplicative(&mut self) -> Result<Expression, RestrictedCelError> {
        self.parse_binary(|p| p.parse_unary(), &["*", "/", "%"])
    }

    fn parse_binary(
        &mut self,
        parse_operand: impl Fn(&mut Parser) -> Result<Expression, RestrictedCelError>,
        operators: &[&str],
    ) -> Result<Expression, RestrictedCelError> {
        let mut expression = parse_operand(self)?;
        loop {
            let current = self.current();
            if current.kind != TokenKind::Operator || !operators.contains(&current.value.as_str()) {
                return Ok(expression);
            }
            let operator = self.advance();
            let right = parse_operand(self)?;
            expression = Expression::Binary {
                operator: operator.value,
                left: Box::new(expression),
                right: Box::new(right),
                offset: operator.offset,
            };
        }
    }

    fn parse_unary(&mut self) -> Result<Expression, RestrictedCelError> {
        let token = self.current();
        if token.kind == TokenKind::Operator
            && (token.value == "!" || token.value == "-" || token.value == "+")
        {
            let operator = token.value.chars().next().unwrap();
            let offset = token.offset;
            self.advance();
            let operand = self.parse_unary()?;
            return Ok(Expression::Unary {
                operator,
                operand: Box::new(operand),
                offset,
            });
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expression, RestrictedCelError> {
        let token = self.advance();
        match token.kind {
            TokenKind::Number => {
                let value: f64 = token.value.parse().map_err(|_| {
                    RestrictedCelError::new("number literal is not JSON-safe".into(), token.offset)
                })?;
                if !value.is_finite()
                    || (value.fract() == 0.0 && value.abs() > 9_007_199_254_740_992.0)
                {
                    return Err(RestrictedCelError::new(
                        "number literal is not JSON-safe".into(),
                        token.offset,
                    ));
                }
                Ok(Expression::Literal {
                    value: number_value(value),
                    offset: token.offset,
                })
            }
            TokenKind::String => Ok(Expression::Literal {
                value: serde_json::Value::String(token.value),
                offset: token.offset,
            }),
            TokenKind::Identifier => {
                if self.current().value == "(" {
                    return Err(RestrictedCelError::new(
                        "function calls are not supported".into(),
                        self.current().offset,
                    ));
                }
                if token.value == self.variable_name.as_str() {
                    return Ok(Expression::Input {
                        offset: token.offset,
                    });
                }
                match token.value.as_str() {
                    "true" => Ok(Expression::Literal {
                        value: serde_json::Value::Bool(true),
                        offset: token.offset,
                    }),
                    "false" => Ok(Expression::Literal {
                        value: serde_json::Value::Bool(false),
                        offset: token.offset,
                    }),
                    "null" => Ok(Expression::Literal {
                        value: serde_json::Value::Null,
                        offset: token.offset,
                    }),
                    _ => Err(RestrictedCelError::new(
                        format!(
                            "unknown identifier {}",
                            serde_json::to_string(&token.value).unwrap_or_default()
                        ),
                        token.offset,
                    )),
                }
            }
            _ => {
                if token.value == "(" {
                    let expression = self.parse_conditional()?;
                    self.expect(")")?;
                    return Ok(expression);
                }
                if token.value == "[" {
                    return self.parse_array(token.offset);
                }
                if token.value == "{" {
                    return self.parse_object(token.offset);
                }
                Err(RestrictedCelError::new(
                    format!(
                        "unexpected token {}",
                        serde_json::to_string(&token.value).unwrap_or_default()
                    ),
                    token.offset,
                ))
            }
        }
    }

    fn parse_array(&mut self, offset: usize) -> Result<Expression, RestrictedCelError> {
        let mut elements = Vec::new();
        if !self.consume("]") {
            loop {
                elements.push(self.parse_conditional()?);
                if !self.consume(",") {
                    break;
                }
            }
            self.expect("]")?;
        }
        Ok(Expression::Array { elements, offset })
    }

    fn parse_object(&mut self, offset: usize) -> Result<Expression, RestrictedCelError> {
        let mut entries = Vec::new();
        let mut keys = std::collections::HashSet::new();
        if !self.consume("}") {
            loop {
                let key = self.advance();
                if key.kind != TokenKind::String {
                    return Err(RestrictedCelError::new(
                        "object keys must be string literals".into(),
                        key.offset,
                    ));
                }
                if !keys.insert(key.value.clone()) {
                    return Err(RestrictedCelError::new(
                        format!(
                            "duplicate object key {}",
                            serde_json::to_string(&key.value).unwrap_or_default()
                        ),
                        key.offset,
                    ));
                }
                self.expect(":")?;
                let value = self.parse_conditional()?;
                entries.push((key.value, value, key.offset));
                if !self.consume(",") {
                    break;
                }
            }
            self.expect("}")?;
        }
        Ok(Expression::Object { entries, offset })
    }

    fn consume(&mut self, value: &str) -> bool {
        if self.current().value != value {
            return false;
        }
        self.index += 1;
        true
    }

    fn expect(&mut self, value: &str) -> Result<Token, RestrictedCelError> {
        let token = self.current();
        if token.value != value {
            return Err(RestrictedCelError::new(
                format!(
                    "expected {}",
                    serde_json::to_string(&value).unwrap_or_default()
                ),
                token.offset,
            ));
        }
        self.index += 1;
        Ok(token)
    }

    fn advance(&mut self) -> Token {
        let token = self.current();
        if token.kind != TokenKind::Eof {
            self.index += 1;
        }
        token
    }

    fn current(&self) -> Token {
        self.tokens
            .get(self.index)
            .cloned()
            .unwrap_or_else(|| self.tokens.last().cloned().unwrap())
    }
}

/// Integer must fit in a safe JSON integer; fractions must be finite.
/// TS: `!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))`.
pub fn assert_json_safe(value: f64, offset: usize) -> Result<(), RestrictedCelError> {
    if !value.is_finite() || (value.fract() == 0.0 && value.abs() > 9_007_199_254_740_992.0) {
        return Err(RestrictedCelError::new(
            "numeric result is not JSON-safe".into(),
            offset,
        ));
    }
    Ok(())
}

pub fn number_value(value: f64) -> serde_json::Value {
    // JS `JSON.stringify` prints an integer-valued double without a fraction
    // ("4096", not "4096.0"); serde's f64 formatter writes "4096.0", which would
    // change the request bytes the patch produces. Every integer that survives
    // `assert_json_safe` is inside the safe-integer range, so it round-trips
    // through i64 exactly. `-0.0` becomes `0`, as `JSON.stringify(-0)` does.
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_992.0 {
        return serde_json::Value::Number(serde_json::Number::from(value as i64));
    }
    serde_json::Number::from_f64(value)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}
