import { parseSubagentMarkdownSelection, type ModelSelection } from "@zcode/shared";

/** Host/Agent share the official Markdown codec; a Provider migration must first be completed at the user storage boundary. */
export function resolveProfileModelSelection(
  frontmatter: Record<string, unknown>,
): ModelSelection | undefined {
  return parseSubagentMarkdownSelection(frontmatter);
}
