import type { z } from "zod";
import type { ConfigValidationIssue } from "../config-overlay.js";

/** Translates the existing issue protocol; it does not maintain a second list of field or content validations. */
export function validateConfigSchema(
  schema: z.ZodType,
  value: unknown,
  path: readonly string[],
  optionSpec = false,
): readonly ConfigValidationIssue[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue): ConfigValidationIssue => {
    const issuePath = [...path, ...issue.path.map(String)];
    let fieldValue: unknown = value;
    for (const key of issue.path) {
      fieldValue =
        fieldValue !== null && typeof fieldValue === "object"
          ? Reflect.get(fieldValue, key)
          : undefined;
    }
    // Missing literal/enum is invalid_value in Zod, and the existing problem classification of "missing field" must still be maintained.
    const missing =
      ((issue.code === "invalid_type" || issue.code === "invalid_value") && fieldValue == null) ||
      (issue.code === "custom" && issue.params?.configIssueCode === "required-field-missing");
    const invalidUrl = issue.code === "invalid_format" && issue.format === "url";
    return {
      code: missing
        ? "required-field-missing"
        : invalidUrl
          ? "invalid-url"
          : optionSpec || issue.path.includes("optionSpecs")
            ? "invalid-option-spec"
            : "invalid-config",
      path: issuePath,
      message: missing
        ? `Missing required config ${issuePath.join(".")}`
        : invalidUrl
          ? `Config ${issuePath.join(".")} must be a valid URL`
          : issue.message,
    };
  });
}
