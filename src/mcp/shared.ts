const MAX_OUTPUT_CHARS = 20_000;

export function capOutput(text: string, hint = "narrow your query (e.g. pass course_id) to see more"): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n\n...[truncated at ${MAX_OUTPUT_CHARS} chars; ${hint}]`;
}

export function textResult(text: string, hint?: string) {
  return { content: [{ type: "text" as const, text: capOutput(text, hint) }] };
}
