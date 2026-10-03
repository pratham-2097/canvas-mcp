import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAssignment, getPage, listModules } from "../../canvas/endpoints.js";
import { extractLinks, htmlToMarkdown } from "../../canvas/html.js";
import { extractFileText } from "../../extract/index.js";
import type { ServerContext } from "../context.js";
import { textResult } from "../shared.js";

export function registerGatherContextTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "gather_assignment_context",
    {
      title: "Gather Assignment Context",
      description:
        "THE KEY TOOL for catching up on one assignment. Returns one structured bundle: the assignment's details, its module and neighboring items, linked pages and files (with extracted text), and search hits for the assignment's name across the whole course. Use this when the user asks 'what do I need for <assignment>'.",
      inputSchema: z.object({
        course_id: z.number().int(),
        assignment_id: z.number().int(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ course_id, assignment_id }) => {
      const sections: string[] = [];

      const assignment = await getAssignment(ctx.client, course_id, assignment_id);
      const descriptionMarkdown = htmlToMarkdown(assignment.description ?? "");
      sections.push(
        [
          `# ${assignment.name}`,
          `course_id=${course_id} assignment_id=${assignment_id}`,
          `due_at: ${assignment.due_at ?? "no due date"}`,
          `points_possible: ${assignment.points_possible ?? "n/a"}`,
          `submission_types: ${assignment.submission_types.join(", ")}`,
          `html_url: ${assignment.html_url}`,
          "",
          "## Description",
          descriptionMarkdown || "(no description)",
        ].join("\n"),
      );

      if (assignment.rubric && Array.isArray(assignment.rubric) && assignment.rubric.length > 0) {
        sections.push(["## Rubric", "```json", JSON.stringify(assignment.rubric, null, 2), "```"].join("\n"));
      }

      // Module + neighboring items. The assignment's own content may be a
      // module item directly (type Assignment), or its content may live on
      // a linked Page item whose title names the assignment instead.
      const modules = await listModules(ctx.client, course_id).catch(() => []);
      let owningModule: { name: string; items: Array<{ id: number; title: string; type: string; html_url: string; content_id?: number }> } | undefined;
      let matchedItemIndex = -1;

      const assignmentNameLower = assignment.name.toLowerCase();
      const coreName = assignmentNameLower.split(/[-:(]/)[0]?.trim() ?? assignmentNameLower;

      for (const mod of modules) {
        const items = mod.items ?? [];
        let idx = items.findIndex((i) => i.content_id === assignment_id && i.type === "Assignment");
        if (idx === -1 && coreName.length > 3) {
          idx = items.findIndex((i) => i.title.toLowerCase().includes(coreName));
        }
        if (idx !== -1) {
          owningModule = { name: mod.name, items };
          matchedItemIndex = idx;
          break;
        }
      }

      if (owningModule) {
        const { name, items } = owningModule;
        const start = Math.max(0, matchedItemIndex - 2);
        const end = Math.min(items.length, matchedItemIndex + 3);
        const neighbors = items.slice(start, end).map((item, i) => {
          const marker = start + i === matchedItemIndex ? ">> " : "   ";
          return `${marker}[${item.type}] ${item.title} ${item.html_url}`;
        });
        sections.push(["## Module: " + name, ...neighbors].join("\n"));
      } else {
        sections.push("## Module\n(Could not locate this assignment in any module.)");
      }

      // Linked pages and files, with extracted text
      const links = extractLinks(assignment.description ?? "");
      const fileLinks = links.filter((l) => l.kind === "file" && l.fileId);
      const pageLinks = links.filter((l) => l.kind === "page" && l.pageUrl);
      const externalLinks = links.filter((l) => l.kind === "external");

      if (fileLinks.length > 0) {
        const fileSections: string[] = [];
        for (const link of fileLinks) {
          try {
            const meta = await ctx.client.get<{ filename: string; "content-type": string; url: string; size: number }>(`/files/${link.fileId}`);
            if (meta.size > 25 * 1024 * 1024) {
              fileSections.push(`### ${meta.filename}\n${meta.url}\n[file exceeds 25MB, not extracted]`);
              continue;
            }
            const download = await ctx.client.getBytes(meta.url);
            if (!download.ok) {
              fileSections.push(`### ${link.text}\n${link.href}\n[could not download: HTTP ${download.status}]`);
              continue;
            }
            const result = await extractFileText(meta.filename, meta["content-type"], download.bytes);
            fileSections.push(
              `### ${meta.filename}\n${meta.url}\n${result.status === "ok" ? result.text.slice(0, 3000) : `[${result.note}]`}`,
            );
          } catch (err) {
            fileSections.push(`### ${link.text}\n${link.href}\n[error: ${(err as Error).message}]`);
          }
        }
        sections.push(["## Linked files", ...fileSections].join("\n\n"));
      }

      if (pageLinks.length > 0) {
        const pageSections: string[] = [];
        for (const link of pageLinks) {
          try {
            const page = await getPage(ctx.client, link.courseId ?? course_id, link.pageUrl!);
            pageSections.push(`### ${page.title}\n${page.html_url}\n${htmlToMarkdown(page.body ?? "").slice(0, 2000)}`);
          } catch (err) {
            pageSections.push(`### ${link.text}\n${link.href}\n[error: ${(err as Error).message}]`);
          }
        }
        sections.push(["## Linked pages", ...pageSections].join("\n\n"));
      }

      if (externalLinks.length > 0) {
        const lines = externalLinks.map((l) => `- external resource: ${l.text} ${l.href}`);
        sections.push(["## External resources (not scraped)", ...lines].join("\n"));
      }

      // Search hits for the assignment name across the course
      const searchIndex = await ctx.indexManager.getSearchIndex(course_id);
      const hits = searchIndex
        .search(assignment.name, { limit: 10 })
        .filter((h) => h.doc.id !== `assignment-${assignment_id}`);

      if (hits.length > 0) {
        const lines = hits.map(
          (h) => `- [${h.doc.type}] ${h.doc.title} (score=${h.score.toFixed(2)}) ${h.doc.html_url}\n  ${h.text.slice(0, 250).replace(/\n+/g, " ")}`,
        );
        sections.push(["## Other mentions of this assignment across the course", ...lines].join("\n"));
      }

      return textResult(sections.join("\n\n---\n\n"));
    },
  );
}
