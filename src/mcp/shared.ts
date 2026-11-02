import { z } from "zod";

const MAX_OUTPUT_CHARS = 20_000;

export function capOutput(text: string, hint = "narrow your query (e.g. pass course_id) to see more"): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n\n...[truncated at ${MAX_OUTPUT_CHARS} chars; ${hint}]`;
}

export function textResult(text: string, hint?: string) {
  return { content: [{ type: "text" as const, text: capOutput(text, hint) }] };
}

// Shared argument schemas. Descriptions are kept short on purpose: they are
// repeated in every tool that uses them and sent to the model on every turn.
export const courseArg = z.union([z.number(), z.string()]).describe("Course id, code, or name");
export const optionalCourseArg = courseArg.optional();
export const idArg = z.number();
