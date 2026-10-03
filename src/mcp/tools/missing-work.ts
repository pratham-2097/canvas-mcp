import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMissingSubmissions, listCourseAssignments } from "../../canvas/endpoints.js";
import type { ServerContext } from "../context.js";
import { textResult } from "../shared.js";

interface Row {
  id: number;
  course_id: number;
  name: string;
  due_at: string | null;
  points: number | null;
  html_url: string;
  status: string;
}

export function registerMissingWorkTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_missing_work",
    {
      title: "Get Missing Work",
      description:
        "List missing, overdue, and unsubmitted assignments across all courses (or one course if course_id is given), sorted by due date. This is the starting point for 'what do I owe' questions.",
      inputSchema: z.object({
        course_id: z.number().int().optional().describe("Restrict to a single Canvas course id"),
        since: z.string().optional().describe("ISO date; only include assignments due on/after this date"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ course_id, since }) => {
      const sinceDate = since ? new Date(since) : null;
      const missing = await getMissingSubmissions(ctx.client);

      let overdueFromCourses: Awaited<ReturnType<typeof listCourseAssignments>> = [];
      if (course_id) {
        overdueFromCourses = await listCourseAssignments(ctx.client, course_id, "overdue");
      }

      const seen = new Set<number>();
      const rows: Row[] = [];

      for (const a of missing) {
        if (course_id && a.course_id !== course_id) continue;
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        rows.push({ id: a.id, course_id: a.course_id, name: a.name, due_at: a.due_at, points: a.points_possible, html_url: a.html_url, status: "missing" });
      }

      for (const a of overdueFromCourses) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        rows.push({ id: a.id, course_id: a.course_id, name: a.name, due_at: a.due_at, points: a.points_possible, html_url: a.html_url, status: "overdue" });
      }

      const filtered = sinceDate ? rows.filter((r) => r.due_at && new Date(r.due_at) >= sinceDate) : rows;

      filtered.sort((a, b) => {
        if (!a.due_at) return 1;
        if (!b.due_at) return -1;
        return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
      });

      if (filtered.length === 0) {
        return textResult("No missing, overdue, or unsubmitted work found. You're caught up!");
      }

      const lines = filtered.map(
        (r) =>
          `- [${r.status}] ${r.name} (assignment_id=${r.id}, course_id=${r.course_id}) due=${r.due_at ?? "no due date"} points=${r.points ?? "n/a"}\n  ${r.html_url}`,
      );

      return textResult(`${filtered.length} item(s):\n${lines.join("\n")}`);
    },
  );
}
