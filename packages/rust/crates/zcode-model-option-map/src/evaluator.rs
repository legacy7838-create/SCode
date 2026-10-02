//! Restricted-CEL evaluator.
//!
//! Faithful port of `packages/model-option-map/src/evaluator.ts`. Numbers are
//! IEEE-754 doubles on both sides, so arithmetic parity holds. One deliberate
//! difference from ECMAScript semantics, mirroring the TS `jsonEquals`:
//! `0` and `-0` are distinct for the first `Object.is` step, then equal via the
//! same-type comparison — serde_json normalises `-0` to `0`, so the distinction
//! is lost there; this evaluator never produces `-0` as an operand pair, so the
//! comparison outcome is unchanged for every input the compiler admits.

use crate::parser::{assert_json_safe, number_value, Expression};
use crate::types::RestrictedCelError;

/// Input to `evaluate`: a JSON string or number, the only two types the
/// restricted grammar can bind to the input variable.
pub type RestrictedCelInput = serde_json::Value;

pub fn evaluate(
    expression: &Expression,
    input: &RestrictedCelInput,
) -> Result<serde_json::Value, RestrictedCelError> {
    assert_input(input, expression.offset())?;
    Ok(evaluate_inner(expression, input)?)
}

fn assert_input(value: &serde_json::Value, offset: usize) -> Result<(), RestrictedCelError> {
    match value {
        serde_json::Value::String(_) => Ok(()),
        serde_json::Value::Number(number) => {
            let value = number.as_f64().ok_or_else(|| {
                RestrictedCelError::new("input value must be a string or number".into(), offset)
            })?;
            assert_json_safe(value, offset)
        }
        _ => Err(RestrictedCelError::new(
            "input value must be a string or number".into(),
            offset,
        )),
    }
}

fn evaluate_inner(
    expression: &Expression,
    input: &RestrictedCelInput,
) -> Result<serde_json::Value, RestrictedCelError> {
    match expression {
        Expression::Literal { value, .. } => Ok(value.clone()),
        Expression::Input { .. } => Ok(input.clone()),
        Expression::Array { elements, .. } => {
            let mut out = Vec::with_capacity(elements.len());
            for element in elements {
                out.push(evaluate_inner(element, input)?);
            }
            Ok(serde_json::Value::Array(out))
        }
        Expression::Object { entries, .. } => {
            let mut map = serde_json::Map::new();
            for (key, value, _) in entries {
                map.insert(key.clone(), evaluate_inner(value, input)?);
            }
            Ok(serde_json::Value::Object(map))
        }
        Expression::Unary {
            operator,
            operand,
            offset,
        } => {
            let value = evaluate_inner(operand, input)?;
            if *operator == '!' {
                return Ok(serde_json::Value::Bool(!require_boolean(&value, *offset)?));
            }
            let number = require_number(&value, *offset)?;
            let result = if *operator == '-' { -number } else { number };
            assert_json_safe(result, *offset)?;
            Ok(number_value(result))
        }
        Expression::Binary {
            operator,
            left,
            right,
            offset,
        } => evaluate_binary(operator, left, right, *offset, input),
        Expression::Conditional {
            condition,
            when_true,
            when_false,
            ..
        } => {
            let value = evaluate_inner(condition, input)?;
            if require_boolean(&value, condition.offset())? {
                evaluate_inner(when_true, input)
            } else {
                evaluate_inner(when_false, input)
            }
        }
    }
}

fn evaluate_binary(
    operator: &str,
    left: &Expression,
    right: &Expression,
    offset: usize,
    input: &RestrictedCelInput,
) -> Result<serde_json::Value, RestrictedCelError> {
    let left_value = evaluate_inner(left, input)?;
    match operator {
        "&&" => {
            let left = require_boolean(&left_value, left.offset())?;
            if !left {
                return Ok(serde_json::Value::Bool(false));
            }
            let right_value = evaluate_inner(right, input)?;
            return Ok(serde_json::Value::Bool(require_boolean(
                &right_value,
                right.offset(),
            )?));
        }
        "||" => {
            let left = require_boolean(&left_value, left.offset())?;
            if left {
                return Ok(serde_json::Value::Bool(true));
            }
            let right_value = evaluate_inner(right, input)?;
            return Ok(serde_json::Value::Bool(require_boolean(
                &right_value,
                right.offset(),
            )?));
        }
        _ => {}
    }
    let right_value = evaluate_inner(right, input)?;
    match operator {
        "==" => Ok(serde_json::Value::Bool(json_equals(
            &left_value,
            &right_value,
        ))),
        "!=" => Ok(serde_json::Value::Bool(!json_equals(
            &left_value,
            &right_value,
        ))),
        "+" => match (&left_value, &right_value) {
            (serde_json::Value::String(a), serde_json::Value::String(b)) => {
                Ok(serde_json::Value::String(format!("{a}{b}")))
            }
            _ => {
                let a = require_number(&left_value, left.offset())?;
                let b = require_number(&right_value, right.offset())?;
                let result = a + b;
                assert_json_safe(result, offset)?;
                Ok(number_value(result))
            }
        },
        "-" | "*" | "/" | "%" => {
            let a = require_number(&left_value, left.offset())?;
            let b = require_number(&right_value, right.offset())?;
            let result = match operator {
                "-" => a - b,
                "*" => a * b,
                "/" => a / b,
                _ => a % b,
            };
            assert_json_safe(result, offset)?;
            Ok(number_value(result))
        }
        "<" | "<=" | ">" | ">=" => compare(&left_value, &right_value, operator, offset),
        other => Err(RestrictedCelError::new(
            format!("unsupported operator {other}"),
            offset,
        )),
    }
}

fn compare(
    left: &serde_json::Value,
    right: &serde_json::Value,
    operator: &str,
    offset: usize,
) -> Result<serde_json::Value, RestrictedCelError> {
    let ordering = match (left, right) {
        (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            a.partial_cmp(&b)
        }
        (serde_json::Value::String(a), serde_json::Value::String(b)) => Some(a.cmp(b)),
        _ => None,
    };
    let ordering = ordering.ok_or_else(|| {
        RestrictedCelError::new(
            "comparison operands must have the same numeric or string type".into(),
            offset,
        )
    })?;
    let result = match operator {
        "<" => ordering.is_lt(),
        "<=" => ordering.is_le(),
        ">" => ordering.is_gt(),
        _ => ordering.is_ge(),
    };
    Ok(serde_json::Value::Bool(result))
}

fn require_boolean(value: &serde_json::Value, offset: usize) -> Result<bool, RestrictedCelError> {
    value
        .as_bool()
        .ok_or_else(|| RestrictedCelError::new("boolean operand required".into(), offset))
}

fn require_number(value: &serde_json::Value, offset: usize) -> Result<f64, RestrictedCelError> {
    match value.as_f64() {
        Some(number) => Ok(number),
        None => Err(RestrictedCelError::new(
            "numeric operand required".into(),
            offset,
        )),
    }
}

fn json_equals(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    match (left, right) {
        (serde_json::Value::Array(a), serde_json::Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| json_equals(x, y))
        }
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| json_equals(value, other)))
        }
        _ => left == right,
    }
}
