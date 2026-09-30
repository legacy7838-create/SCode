import type { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "@zcode/shared";

// Freeze 0002's pre-release adjudicated encoding; runtime parser/identity tables that may be modified in the future cannot be called.
// Keep escaping and delimiting priorities consistent with old decodeCustomModelValue / parseModelPickerValue.
const providerNames: Readonly<Record<string, string>> = {
  "builtin:bigmodel": "bigmodel-api",
  "builtin:zai": "zai-api",
  "builtin:bigmodel-start-plan": "account:bigmodel-start-plan",
  "builtin:zai-start-plan": "account:zai-start-plan",
  "builtin:bigmodel-coding-plan": "account:bigmodel-individual-coding-plan",
  "builtin:zai-coding-plan": "account:zai-individual-coding-plan",
};
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface LegacySelectionRow {
  automation_id: string;
  model: string | null;
  provider: string | null;
  thought_level: string | null;
}

function decodeLegacySelection(row: LegacySelectionRow): ModelSelection | undefined {
  const value = row.model?.trim();
  if (!value) return undefined;
  let provider = row.provider?.trim() ?? "";
  let model = value;
  let reasoningLevel = row.thought_level?.trim();
  if (value.startsWith("custom:")) {
    const body = value.slice(7);
    const separator = body.indexOf(":");
    if (separator < 0) return undefined;
    const parts = body.split(":");
    if (parts.length >= 3 && parts[0] === "builtin") {
      provider = `builtin:${parts[1]}`;
      model = decodeComponent(parts.slice(2).join(":"));
    } else {
      provider = decodeComponent(body.slice(0, separator));
      model = decodeComponent(body.slice(separator + 1));
    }
  } else if (value.includes("/")) {
    const separator = value.indexOf("/");
    provider = value.slice(0, separator);
    model = value.slice(separator + 1);
    const levelSeparator = model.indexOf("$");
    if (levelSeparator > 0 && levelSeparator < model.length - 1) {
      reasoningLevel = model.slice(levelSeparator + 1).trim();
      if (!reasoningLevel) return undefined;
      model = model.slice(0, levelSeparator);
    }
  } else if (["glm", "zcode"].includes(provider)) {
    // The old provider=glm/zcode is the execution backend, not the provider identity.
    return undefined;
  }
  provider = provider.trim();
  model = model.trim();
  if (!provider || !model) return undefined;
  const providerId = provider.startsWith("builtin:") ? providerNames[provider] : provider;
  if (!providerId) return undefined;
  return { providerId, modelId: model, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) };
}

/**
 * The frozen rules of 0002, as data: `decoded` is `JSON.stringify(selection)`, or SQL `NULL` when
 * the legacy identity could not be determined.
 *
 * Extracted so `importLegacyAutomationSelections` and `offpeakMigrationSql`'s `0002` body derive
 * from one implementation of the escaping order and the identity table rather than two.
 */
export function legacySelectionRules(rows: readonly LegacySelectionRow[]): LegacySelectionRule[] {
  return rows.map((row) => ({
    automationId: row.automation_id,
    model: row.model,
    provider: row.provider,
    thoughtLevel: row.thought_level,
    decoded: decodeLegacySelection(row),
  }));
}

export interface LegacySelectionRule {
  automationId: string;
  model: string | null;
  provider: string | null;
  thoughtLevel: string | null;
  /** `undefined` when the identity cannot be determined — the frozen rules write SQL `NULL` then. */
  decoded: ModelSelection | undefined;
}

/** Every row 0002 considers: the legacy columns, but only where `model` is not SQL NULL. */
export const LEGACY_SELECTION_SOURCE_SQL =
  "SELECT automation_id, model, provider, thought_level FROM automations WHERE model IS NOT NULL";

/**
 * The 0002 body as emitted SQL.
 *
 * `0002` is already applied on every existing install, so this is **frozen history, not a live
 * migration**: the decoder above is a record of one historical transformation, and the native
 * runner needs that same transformation as a payload it can execute. The statements come from
 * `legacySelectionRules`, so the rules exist once.
 *
 * `importLegacyAutomationSelections` is deliberately **not** called here: it needs a live
 * `DatabaseSync`, and nothing on the live path may depend on a frozen migration's decoder
 * (spec §19a). The emitted SQL is the equivalent body; `legacy-selection-render-parity.test.ts`
 * pins the two against each other so neither can drift.
 *
 * The `existing` pre-image is the **stored `model_selection` text** per automation, embedded rather
 * than re-read, and that is exact rather than an approximation: each `UPDATE` is guarded by
 * `model IS ? AND provider IS ? AND thought_level IS ?`, so a statement can only take effect while
 * the row still holds the snapshot the rule was built from — the same snapshot the JavaScript read.
 * A pre-image that has since changed makes the guard fail, so the pre-check costs nothing and only
 * keeps the payload small. `null` means the column is SQL NULL. Encoding uses `hex()` so the payload
 * carries no quoting or escaping of its own.
 */
export function legacySelectionSql(
  rows: readonly LegacySelectionRow[],
  existing: ReadonlyMap<string, string | null>,
): string {
  const statements: string[] = [];
  for (const rule of legacySelectionRules(rows)) {
    if (!rule.decoded) {
      if (!rule.model?.trim()) continue;
      // Frozen semantics: an old explicit intention whose identity cannot be determined is
      // cleared, rather than guessed at.
      if (existing.get(rule.automationId) === null) continue;
      statements.push(
        `UPDATE automations SET model_selection=NULL WHERE automation_id=${sqlText(rule.automationId)};`,
      );
      continue;
    }
    // The IS-guard already prevents a stale write, so the pre-image check is a size guard.
    const decoded = JSON.stringify(rule.decoded);
    if (existing.get(rule.automationId) === decoded) continue;
    statements.push(
      `UPDATE automations SET model_selection=${sqlJson(decoded)} WHERE automation_id=${sqlText(
        rule.automationId,
      )} AND model IS ${sqlNullableText(rule.model)} AND provider IS ${sqlNullableText(
        rule.provider,
      )} AND thought_level IS ${sqlNullableText(rule.thoughtLevel)};`,
    );
  }
  // The final sweep is unconditional and idempotent in both implementations.
  statements.push(`UPDATE automations SET model_selection='null'
    WHERE model_selection IS NULL AND (model IS NULL OR trim(model)='');`);
  return statements.join("\n");
}

/** A SQL string literal; `''` is only ever emitted for input that cannot be stored verbatim anyway. */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A SQL `TEXT` literal encoding a JSON payload, escaping-free through `hex()`. */
function sqlJson(json: string): string {
  return `CAST(X'${Buffer.from(json, "utf8").toString("hex")}' AS TEXT)`;
}

function sqlNullableText(value: string | null): string {
  return value === null ? "NULL" : sqlJson(value);
}

/**
 * One-time conversion frozen into 0002: the runtime Reader only looks at the new column, and the three legacy columns are kept as-is.
 * Where a legacy source exists the unpublished target value may be rebuilt; when the identity cannot be determined it stays SQL NULL, and the default semantics are written as JSON null.
 * Must be called inside the database-level migration transaction; per-read imports must not come back.
 */
export function importLegacyAutomationSelections(db: DatabaseSync): void {
  const rows = db
    .prepare(LEGACY_SELECTION_SOURCE_SQL)
    .all() as unknown as LegacySelectionRow[];
  for (const rule of legacySelectionRules(rows)) {
    if (!rule.decoded) {
      // There is an old explicit intention but the identity cannot be determined, the "default" of unreleased intermediate states is not retained, and silent model changes are avoided.
      if (rule.model?.trim())
        db.prepare("UPDATE automations SET model_selection=NULL WHERE automation_id=?").run(
          rule.automationId,
        );
      continue;
    }
    // The outer IMMEDIATE transaction guarantees that the old source and write are from the same snapshot; none of the old columns/timestamps are modified.
    db.prepare(
      `UPDATE automations SET model_selection = ?
       WHERE automation_id = ?
         AND model IS ? AND provider IS ? AND thought_level IS ?`,
    ).run(
      JSON.stringify(rule.decoded),
      rule.automationId,
      rule.model,
      rule.provider,
      rule.thoughtLevel,
    );
  }
  db.exec(`UPDATE automations SET model_selection='null'
    WHERE model_selection IS NULL AND (model IS NULL OR trim(model)='')`);
}
