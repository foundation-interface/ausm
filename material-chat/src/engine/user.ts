import { config } from "../config.js";
import { loadPromptTemplate } from "./prompts.js";

/**
 * Returns a small block describing the user the agent is serving, suitable
 * for appending to a system prompt. Empty string when no identity is set.
 *
 * The text is loaded from prompts/user_context_template.txt with two
 * placeholders:
 *   {USER_NAME}          — replaced with config.userName
 *   {USER_ALIASES_NOTE}  — either empty, or " They may appear in their own
 *                          captured materials as: \"x\", \"y\"."
 *                          (leading space included so it flows after the
 *                          period in the previous sentence)
 */
export function userContextBlock(): string {
  if (!config.userName) return "";

  const aliasesNote = config.userAliases.length
    ? ` They may appear in their own captured materials as: ${config.userAliases
        .map((a) => `"${a}"`)
        .join(", ")}.`
    : "";

  return loadPromptTemplate("user_context_template", {
    USER_NAME: config.userName,
    USER_ALIASES_NOTE: aliasesNote,
  });
}
