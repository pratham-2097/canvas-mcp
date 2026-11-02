import { z } from "zod";
import { CanvasApiError } from "../../canvas/client.js";
import { getFile } from "../../canvas/endpoints.js";
import { extractFileText } from "../../extract/index.js";
import type { ServerContext } from "../context.js";
import { fmtDate, oneLine } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { optionalCourseArg } from "../shared.js";

interface FileRow {
  id: number;
  display_name: string;
  size: number;
  updated_at: string;
  hidden_for_user?: boolean;
  locked_for_user?: boolean;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PAGE_CHARS = 18_000;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function registerFileTools(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "list_files",
    description: "List a course's or group's files (newest first), optionally filtered by name. Read one with get_file_text.",
    input: {
      course_id: optionalCourseArg,
      group_id: z.number().optional(),
      search: z.string().min(2).optional(),
      limit: z.number().int().min(1).max(200).optional().describe("default 50"),
    },
    run: async ({ course_id, group_id, search, limit }) => {
      if (course_id === undefined && group_id === undefined) throw new Error("Pass course_id or group_id.");
      const path = group_id !== undefined ? `/groups/${group_id}/files` : `/courses/${await ctx.resolveCourseId(course_id!)}/files`;
      let files: FileRow[];
      try {
        files = await ctx.client.getPaginated<FileRow>(path, { search_term: search, sort: "updated_at", order: "desc" }, 3);
      } catch (err) {
        if (err instanceof CanvasApiError && (err.status === 401 || err.status === 403)) {
          return "Canvas hides this Files list from students. Files linked from pages/assignments are still searchable: use search_course with types=[\"file\"], or list_modules.";
        }
        throw err;
      }
      const visible = files.filter((f) => !f.hidden_for_user).slice(0, limit ?? 50);
      if (visible.length === 0) return search ? `No files match "${search}".` : "No files.";
      const lines = visible.map((f) => `- file_id=${f.id} ${oneLine(f.display_name, 100)} · ${size(f.size)} · ${fmtDate(f.updated_at, ctx.timeZone)}${f.locked_for_user ? " · locked" : ""}`);
      const more = files.length > visible.length ? `\n(${files.length - visible.length} more; narrow with search)` : "";
      return `${visible.length} file(s):\n${lines.join("\n")}${more}`;
    },
  });

  reg.add({
    name: "get_file_text",
    description: "Download a Canvas file by id and extract its text (PDF, DOCX, PPTX, text/code). Long files are paged: pass offset to continue.",
    input: {
      file_id: z.number(),
      offset: z.number().int().min(0).optional().describe("Char offset for the next page"),
    },
    run: async ({ file_id, offset }) => {
      const meta = await getFile(ctx.client, file_id);
      if (meta.size > MAX_FILE_BYTES) return `# ${meta.filename}\nFile is ${size(meta.size)}, over the 25MB extraction limit.`;
      const download = await ctx.client.getBytes(meta.url);
      if (!download.ok) return `Could not download file ${file_id} (${meta.filename}): HTTP ${download.status}`;
      const result = await extractFileText(meta.filename, meta["content-type"], download.bytes);
      const start = offset ?? 0;
      const page = result.text.slice(start, start + PAGE_CHARS);
      const end = start + page.length;
      const paging = result.text.length > PAGE_CHARS
        ? `chars ${start}-${end} of ${result.text.length}${end < result.text.length ? ` (next: offset=${end})` : " (end)"}\n`
        : "";
      return `# ${meta.filename} (file_id=${file_id})\nstatus: ${result.status}${result.note ? ` (${result.note})` : ""}\n${paging}\n${page}`;
    },
  });
}
