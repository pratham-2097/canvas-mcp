import { z } from "zod";
import { getPage, listModules } from "../../canvas/endpoints.js";
import { extractLinks, htmlToMarkdown } from "../../canvas/html.js";
import { extractFileText } from "../../extract/index.js";
import type { ServerContext } from "../context.js";
import { mapLimit, oneLine } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { courseArg } from "../shared.js";
import { assignmentHeader, loadAssignmentWithSubmission, renderRubric } from "./assignments.js";

const MAX_LINKED_FILES = 6;
const MAX_LINKED_PAGES = 6;

export function registerGatherContextTool(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "gather_assignment_context",
    description:
      "Everything needed to do one assignment in a single call: details, rubric, your submission, its module and neighboring items, text of linked files and pages, and mentions elsewhere in the course. Use for 'help me with <assignment>'.",
    input: { course_id: courseArg, assignment_id: z.number() },
    run: async ({ course_id, assignment_id }) => {
      const courseId = await ctx.resolveCourseId(course_id);
      const [{ a: assignment, submission }, modules] = await Promise.all([
        loadAssignmentWithSubmission(ctx, courseId, assignment_id),
        listModules(ctx.client, courseId).catch(() => []),
      ]);
      const sections: string[] = [];
      const status = submission
        ? submission.score !== null && submission.score !== undefined
          ? `Your score: ${submission.score}/${assignment.points_possible ?? "-"}`
          : submission.submitted_at ? "You've submitted; not graded yet." : submission.missing ? "Status: MISSING" : "Status: not submitted"
        : "";
      sections.push([assignmentHeader(assignment, courseId, ctx.timeZone), status].filter(Boolean).join("\n"));
      sections.push(`## Description\n${htmlToMarkdown(assignment.description ?? "") || "(no description)"}`);
      const rubric = renderRubric(assignment.rubric, submission?.rubric_assessment);
      if (rubric) sections.push(rubric);

      // Module + neighbors. The assignment may be a module item itself, or its
      // content may live on a Page item whose title names it.
      const nameLower = assignment.name.toLowerCase();
      const coreName = nameLower.split(/[-:(]/)[0]?.trim() ?? nameLower;
      let owning: { name: string; items: NonNullable<(typeof modules)[number]["items"]>; idx: number } | undefined;
      for (const mod of modules) {
        const items = mod.items ?? [];
        let idx = items.findIndex((i) => i.content_id === assignment_id && i.type === "Assignment");
        if (idx === -1 && coreName.length > 3) idx = items.findIndex((i) => i.title.toLowerCase().includes(coreName));
        if (idx !== -1) {
          owning = { name: mod.name, items, idx };
          break;
        }
      }
      if (owning) {
        const start = Math.max(0, owning.idx - 2);
        const neighbors = owning.items.slice(start, owning.idx + 3).map((item, i) => {
          const ref = item.type === "Page" ? ` (page_url=${item.page_url})` : item.type === "File" ? ` (file_id=${item.content_id})` : "";
          return `${start + i === owning.idx ? ">>" : "  "} [${item.type}] ${item.title}${ref}`;
        });
        sections.push([`## Module: ${owning.name}`, ...neighbors].join("\n"));
      }

      const links = extractLinks(assignment.description ?? "");
      const fileIds = [...new Set(links.filter((l) => l.kind === "file" && l.fileId).map((l) => l.fileId!))].slice(0, MAX_LINKED_FILES);
      const pageLinks = links.filter((l) => l.kind === "page" && l.pageUrl).slice(0, MAX_LINKED_PAGES);
      const external = links.filter((l) => l.kind === "external");

      const [files, pages, searchIndex] = await Promise.all([
        mapLimit(fileIds, 3, async (fileId) => {
          try {
            const meta = await ctx.client.get<{ filename: string; "content-type": string; url: string; size: number }>(`/files/${fileId}`);
            if (meta.size > 25 * 1024 * 1024) return `### ${meta.filename} (file_id=${fileId})\n[over 25MB, not extracted]`;
            const download = await ctx.client.getBytes(meta.url);
            if (!download.ok) return `### file_id=${fileId}\n[could not download: HTTP ${download.status}]`;
            const result = await extractFileText(meta.filename, meta["content-type"], download.bytes);
            const text = result.status === "ok" ? result.text.slice(0, 3000) + (result.text.length > 3000 ? "\n…(more: get_file_text)" : "") : `[${result.note}]`;
            return `### ${meta.filename} (file_id=${fileId})\n${text}`;
          } catch (err) {
            return `### file_id=${fileId}\n[error: ${(err as Error).message.slice(0, 150)}]`;
          }
        }),
        mapLimit(pageLinks, 3, async (link) => {
          try {
            const page = await getPage(ctx.client, link.courseId ?? courseId, link.pageUrl!);
            return `### ${page.title} (page_url=${link.pageUrl})\n${htmlToMarkdown(page.body ?? "").slice(0, 2000)}`;
          } catch (err) {
            return `### ${link.text}\n[error: ${(err as Error).message.slice(0, 150)}]`;
          }
        }),
        ctx.indexManager.getSearchIndex(courseId).then((r) => r.index).catch(() => null),
      ]);
      if (files.length) sections.push(["## Linked files", ...files].join("\n\n"));
      if (pages.length) sections.push(["## Linked pages", ...pages].join("\n\n"));
      if (external.length) sections.push(["## External links (not scraped)", ...external.map((l) => `- ${l.text} ${l.href}`)].join("\n"));

      const hits = searchIndex?.search(assignment.name, { limit: 8 }).filter((h) => h.doc.id !== `assignment-${assignment_id}`) ?? [];
      if (hits.length) {
        sections.push(["## Mentions elsewhere in the course", ...hits.map((h) => `- [${h.doc.type}] ${h.doc.title} (${h.doc.id}): ${oneLine(h.text, 220)}`)].join("\n"));
      }
      return sections.join("\n\n---\n\n");
    },
  });
}
