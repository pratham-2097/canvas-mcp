import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCourseWithSyllabus, getFile, getPage, listAnnouncements, listModules } from "../../canvas/endpoints.js";
import { htmlToMarkdown } from "../../canvas/html.js";
import { extractFileText } from "../../extract/index.js";
import type { ServerContext } from "../context.js";
import { textResult } from "../shared.js";

export function registerContentTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "list_modules",
    {
      title: "List Modules",
      description: "List a course's modules with their items, in order. Useful to see what an assignment is near.",
      inputSchema: z.object({ course_id: z.number().int() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ course_id }) => {
      const modules = await listModules(ctx.client, course_id);
      const lines = modules.map((m) => {
        const items = (m.items ?? [])
          .map((i) => `    - [${i.type}] ${i.title} ${i.html_url}`)
          .join("\n");
        return `- Module: ${m.name}\n${items}`;
      });
      return textResult(lines.join("\n\n") || "No modules found.");
    },
  );

  server.registerTool(
    "get_page",
    {
      title: "Get Page",
      description: "Get a course wiki page's content as markdown, by its page url slug (from list_modules or a link).",
      inputSchema: z.object({ course_id: z.number().int(), page_url: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ course_id, page_url }) => {
      const page = await getPage(ctx.client, course_id, page_url);
      return textResult(`# ${page.title}\n${page.html_url}\n\n${htmlToMarkdown(page.body ?? "")}`);
    },
  );

  server.registerTool(
    "get_file_text",
    {
      title: "Get File Text",
      description: "Download a Canvas file by id and extract its text (PDF, DOCX, PPTX, or plain text/code).",
      inputSchema: z.object({ file_id: z.number().int() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ file_id }) => {
      const meta = await getFile(ctx.client, file_id);
      const download = await ctx.client.getBytes(meta.url);
      if (!download.ok) {
        return textResult(`Could not download file ${file_id} (${meta.filename}): HTTP ${download.status}`);
      }
      const result = await extractFileText(meta.filename, meta["content-type"], download.bytes);
      const header = `# ${meta.filename}\n${meta.url}\nstatus: ${result.status}${result.note ? ` (${result.note})` : ""}\n\n`;
      return textResult(header + result.text);
    },
  );

  server.registerTool(
    "list_announcements",
    {
      title: "List Announcements",
      description: "List a course's announcements, optionally since a given date, newest first.",
      inputSchema: z.object({ course_id: z.number().int(), since: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ course_id, since }) => {
      const announcements = await listAnnouncements(ctx.client, course_id, since);
      const lines = announcements.map(
        (a) => `- ${a.title} (posted ${a.posted_at})\n  ${a.html_url}\n  ${htmlToMarkdown(a.message ?? "").slice(0, 300)}`,
      );
      return textResult(lines.join("\n\n") || "No announcements found.");
    },
  );

  server.registerTool(
    "get_syllabus",
    {
      title: "Get Syllabus",
      description: "Get a course's syllabus body as markdown.",
      inputSchema: z.object({ course_id: z.number().int() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ course_id }) => {
      const course = await getCourseWithSyllabus(ctx.client, course_id);
      if (!course.syllabus_body) return textResult("This course has no syllabus body set.");
      return textResult(`# ${course.name} — Syllabus\n\n${htmlToMarkdown(course.syllabus_body)}`);
    },
  );

  server.registerTool(
    "refresh_course_index",
    {
      title: "Refresh Course Index",
      description: "Force a fresh crawl of a course's content (bypassing the 6h cache). Use if content seems stale.",
      inputSchema: z.object({ course_id: z.number().int() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ course_id }) => {
      const index = await ctx.indexManager.getIndex(course_id, true);
      return textResult(`Refreshed index for course ${course_id}: ${index.documents.length} documents indexed.`);
    },
  );
}
