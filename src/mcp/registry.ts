import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { textResult } from "./shared.js";

type Shape = z.ZodRawShape;

export interface ToolDef<S extends Shape> {
  name: string;
  description: string;
  input: S;
  run: (args: z.infer<z.ZodObject<S>>) => Promise<string>;
  /** Hint appended when output is truncated. */
  truncateHint?: string;
}

/**
 * Collects every tool so `tools/list` can be served in a slimmed form.
 *
 * The SDK's default listing adds a `$schema` URL, int64 min/max bounds on
 * every integer, an `execution` block, and `title`/`destructiveHint` to each
 * tool. A client such as Claude.ai pays for all of that in context on every
 * turn, so this registry lists only name, description, a minimal input
 * schema and `readOnlyHint`. Calls still go through McpServer, so argument
 * validation is unchanged.
 */
export class ToolRegistry {
  private readonly tools: Tool[] = [];

  constructor(private readonly server: McpServer) {}

  add<S extends Shape>(def: ToolDef<S>): void {
    const schema = z.object(def.input);
    this.server.registerTool(
      def.name,
      { description: def.description, inputSchema: schema, annotations: { readOnlyHint: true } },
      // The SDK's callback typing cannot see through the generic shape.
      (async (args: z.infer<typeof schema>) => {
        try {
          return textResult(await def.run(args), def.truncateHint);
        } catch (err) {
          return { ...textResult(`Error: ${errorMessage(err)}`), isError: true };
        }
      }) as never,
    );
    this.tools.push({
      name: def.name,
      description: def.description,
      inputSchema: slimJsonSchema(schema) as Tool["inputSchema"],
      annotations: { readOnlyHint: true },
    });
  }

  /** Must be called after every tool is added; replaces the SDK's listing. */
  install(): void {
    this.server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.tools }));
  }
}

function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const status = (err as { status?: number }).status;
  // Canvas also answers 401 for "user not authorized to perform that action",
  // so only an explicit invalid-token body means the token itself is bad.
  if (status === 401 && /invalid access token|expired/i.test(err.message)) {
    return "Canvas rejected the access token (401): it is invalid or expired. Generate a new one in Canvas → Account → Settings.";
  }
  if (status === 401 || status === 403) return `Canvas says you don't have permission to see this (${status}). The instructor may have hidden or locked it.`;
  if (status === 404) return "Not found in Canvas (404). Check the id; it may be unpublished or in another course.";
  return err.message.slice(0, 400);
}

function slimJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return strip(json) as Record<string, unknown>;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "additionalProperties" && value === false) continue;
    // z.number().int() emits +/-2^53 bounds that tell a model nothing.
    if ((key === "minimum" || key === "maximum") && Math.abs(value as number) >= Number.MAX_SAFE_INTEGER) continue;
    out[key] = strip(value);
  }
  return out;
}
