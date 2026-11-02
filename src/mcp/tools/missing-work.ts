import { z } from "zod";
import { getMissingSubmissions, listCourseAssignments } from "../../canvas/endpoints.js";
import type { ServerContext } from "../context.js";
import { fmtDate, num } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { optionalCourseArg } from "../shared.js";

interface Row {
  id: number;
  course_id: number;
  name: string;
  due_at: string | null;
  points: number | null;
  html_url: string;
  status: string;
}

export function registerMissingWorkTool(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "get_missing_work",
    description: "Missing and overdue unsubmitted assignments across all courses (or one), oldest due first. Start here for 'what do I owe'.",
    input: {
      course_id: optionalCourseArg,
      since: z.string().optional().describe("ISO date; only items due on/after it"),
    },
    run: async ({ course_id, since }) => {
      const courseId = course_id === undefined ? undefined : await ctx.resolveCourseId(course_id);
      const sinceDate = since ? new Date(since) : null;
      const [missing, overdue] = await Promise.all([
        getMissingSubmissions(ctx.client),
        courseId ? listCourseAssignments(ctx.client, courseId, "overdue") : Promise.resolve([]),
      ]);

      const seen = new Set<number>();
      const rows: Row[] = [];
      for (const [list, status] of [[missing, "missing"], [overdue, "overdue"]] as const) {
        for (const a of list) {
          if (courseId && a.course_id !== courseId) continue;
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          rows.push({ id: a.id, course_id: a.course_id, name: a.name, due_at: a.due_at, points: a.points_possible, html_url: a.html_url, status });
        }
      }

      const filtered = sinceDate ? rows.filter((r) => r.due_at && new Date(r.due_at) >= sinceDate) : rows;
      filtered.sort((a, b) => {
        if (!a.due_at) return 1;
        if (!b.due_at) return -1;
        return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
      });
      if (filtered.length === 0) return "No missing or overdue work. You're caught up!";

      const lines = await Promise.all(
        filtered.map(async (r) =>
          `- [${r.status}] ${r.name} · ${await ctx.courseLabel(r.course_id)} · due ${fmtDate(r.due_at, ctx.timeZone)} · ${num(r.points)}pts (course_id=${r.course_id} assignment_id=${r.id})\n  ${r.html_url}`,
        ),
      );
      return `${filtered.length} item(s):\n${lines.join("\n")}`;
    },
  });
}
