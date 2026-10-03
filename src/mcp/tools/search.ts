import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DocumentType } from "../../index-store/types.js";
import type { ServerContext } from "../context.js";
import { textResult } from "../shared.js";

const DOC_TYPES: DocumentType[] = [
  "assignment", "page", "file", "announcement", "discussion", "module_item", "syllabus", "external",
];

export function registerSearchTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "search_course",
    {
      title: "Search Course",
      description:
        "Full-text search across all of a course's content, including text extracted from files. Builds/uses a cached per-course index (6h TTL). Returns ranked chunks with source links.",
      inputSchema: z.object({
        course_id: z.number().int(),
        query: z.string(),
        types: z.array(z.enum(DOC_TYPES as [DocumentType, ...DocumentType[]])).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        force_refresh: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ course_id, query, types, limit, force_refresh }) => {
      const index = await ctx.indexManager.getSearchIndex(course_id, force_refresh ?? false);
      const results = index.search(query, { types, limit: limit ?? 20 });

      if (results.length === 0) {
        return textResult(`No matches for "${query}" in course ${course_id}.`);
      }

      const lines = results.map(
        (r, i) =>
          `${i + 1}. [${r.doc.type}] ${r.doc.title} (score=${r.score.toFixed(2)})\n   ${r.doc.html_url}\n   ${r.text.slice(0, 400).replace(/\n+/g, " ")}`,
      );

      return textResult(`${results.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`);
    },
  );
}
