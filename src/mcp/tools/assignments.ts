import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAssignment, listActiveCourses, listCourseAssignments } from "../../canvas/endpoints.js";
import { extractLinks, htmlToMarkdown } from "../../canvas/html.js";
import type { ServerContext } from "../context.js";
import { textResult } from "../shared.js";

function similarity(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c === q) return 100;
  if (c.includes(q)) return 80 - Math.abs(c.length - q.length) * 0.1;

  const qTokens = q.split(/\s+/).filter(Boolean);
  const cTokens = c.split(/\s+/).filter(Boolean);
  const matched = qTokens.filter((t) => cTokens.some((ct) => ct.includes(t) || t.includes(ct)));
  return (matched.length / Math.max(qTokens.length, 1)) * 60;
}

export function registerAssignmentTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "find_assignment",
    {
      title: "Find Assignment",
      description:
        "Fuzzy-match an assignment name across one or all courses (e.g. 'Project 1'). Returns candidates ranked by match quality with their course_id and assignment_id, for use with get_assignment or gather_assignment_context.",
      inputSchema: z.object({
        query: z.string().describe("Assignment name or partial name to search for"),
        course_id: z.number().int().optional().describe("Restrict search to a single course"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ query, course_id }) => {
      const courses = course_id
        ? [{ id: course_id, name: "", course_code: "", workflow_state: "" }]
        : await listActiveCourses(ctx.client);

      const candidates: Array<{ score: number; name: string; course_id: number; assignment_id: number; html_url: string; due_at: string | null }> = [];

      for (const course of courses) {
        const assignments = await listCourseAssignments(ctx.client, course.id).catch(() => []);
        for (const a of assignments) {
          const score = similarity(query, a.name);
          if (score > 20) {
            candidates.push({ score, name: a.name, course_id: course.id, assignment_id: a.id, html_url: a.html_url, due_at: a.due_at });
          }
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      const top = candidates.slice(0, 15);

      if (top.length === 0) {
        return textResult(`No assignments matched "${query}".`);
      }

      const lines = top.map(
        (c) => `- ${c.name} (course_id=${c.course_id}, assignment_id=${c.assignment_id}) due=${c.due_at ?? "no due date"}\n  ${c.html_url}`,
      );
      return textResult(`${top.length} match(es) for "${query}":\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "get_assignment",
    {
      title: "Get Assignment",
      description:
        "Get full details for one assignment: markdown description, rubric, dates, submission types, and resolved links found in the description.",
      inputSchema: z.object({
        course_id: z.number().int(),
        assignment_id: z.number().int(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ course_id, assignment_id }) => {
      const a = await getAssignment(ctx.client, course_id, assignment_id);
      const markdown = htmlToMarkdown(a.description ?? "");
      const links = extractLinks(a.description ?? "");

      const linkLines = links.map((l) => {
        if (l.kind === "file") return `  - file: ${l.text} (file_id=${l.fileId}) ${l.href}`;
        if (l.kind === "page") return `  - page: ${l.text} (page_url=${l.pageUrl}) ${l.href}`;
        return `  - external resource: ${l.text} ${l.href}`;
      });

      const parts = [
        `# ${a.name}`,
        `course_id=${course_id} assignment_id=${assignment_id}`,
        `due_at: ${a.due_at ?? "no due date"}`,
        `points_possible: ${a.points_possible ?? "n/a"}`,
        `submission_types: ${a.submission_types.join(", ")}`,
        `html_url: ${a.html_url}`,
        "",
        "## Description",
        markdown || "(no description)",
      ];

      if (links.length > 0) {
        parts.push("", "## Links found in description", ...linkLines);
      }

      if (a.rubric && Array.isArray(a.rubric) && a.rubric.length > 0) {
        parts.push("", "## Rubric", "```json", JSON.stringify(a.rubric, null, 2), "```");
      }

      return textResult(parts.join("\n"));
    },
  );
}
