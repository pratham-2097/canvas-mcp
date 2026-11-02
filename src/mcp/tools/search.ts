import { z } from "zod";
import type { DocumentType } from "../../index-store/types.js";
import type { ServerContext } from "../context.js";
import { oneLine } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { courseArg } from "../shared.js";

const DOC_TYPES: DocumentType[] = [
  "assignment", "page", "file", "announcement", "discussion", "module_item", "syllabus", "external",
];

export function registerSearchTool(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "search_course",
    description:
      "Full-text search over everything in a course, including text inside PDFs/DOCX/PPTX. Returns ranked snippets with ids. First search in a course builds an index (slower; cached 6h). force_refresh re-crawls.",
    input: {
      course_id: courseArg,
      query: z.string(),
      types: z.array(z.enum(DOC_TYPES as [DocumentType, ...DocumentType[]])).optional(),
      limit: z.number().int().min(1).max(50).optional().describe("default 10"),
      force_refresh: z.boolean().optional(),
    },
    run: async ({ course_id, query, types, limit, force_refresh }) => {
      const courseId = await ctx.resolveCourseId(course_id);
      const { index, pendingFiles } = await ctx.indexManager.getSearchIndex(courseId, force_refresh ?? false);
      const results = index.search(query, { types, limit: limit ?? 10 });
      const partial = !pendingFiles
        ? ""
        : ctx.indexManager.extractsFiles
          ? `\n(Index still building: ${pendingFiles} file(s) not yet searched. Repeat the search to include more.)`
          : `\n(File contents aren't indexed on this server (${pendingFiles} files); file names are. Read a file with get_file_text.)`;
      if (results.length === 0) return `No matches for "${query}" in course ${courseId}.${partial}`;

      const lines = results.map(
        (r, i) => `${i + 1}. [${r.doc.type}] ${r.doc.title} (${r.doc.id}) ${r.doc.html_url}\n   ${oneLine(r.text, 350)}`,
      );
      return `${results.length} result(s) for "${query}":\n${lines.join("\n")}${partial}`;
    },
  });
}
