import { z } from "zod";
import type { ServerContext } from "../context.js";
import { fmtDate, mdPreview, num, oneLine } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { optionalCourseArg } from "../shared.js";

interface PlannerItem {
  course_id?: number;
  plannable_id: number;
  plannable_type: string;
  plannable_date: string;
  plannable: {
    title?: string;
    points_possible?: number | null;
    due_at?: string | null;
    todo_date?: string | null;
    start_at?: string | null;
    end_at?: string | null;
    all_day?: boolean;
    location_name?: string | null;
    assignment_id?: number;
    details?: string | null;
    description?: string | null;
  };
  submissions?: false | { submitted?: boolean; excused?: boolean; graded?: boolean; late?: boolean; missing?: boolean; has_feedback?: boolean };
  planner_override?: { marked_complete?: boolean } | null;
  context_name?: string;
  html_url?: string;
}

const KIND: Record<string, string> = {
  assignment: "assignment",
  quiz: "quiz",
  discussion_topic: "discussion",
  wiki_page: "page",
  planner_note: "my note",
  calendar_event: "event",
  assessment_request: "peer review",
  announcement: "announcement",
  sub_assignment: "checkpoint",
};

function isDone(item: PlannerItem): boolean {
  if (item.planner_override?.marked_complete) return true;
  return Boolean(item.submissions && (item.submissions.submitted || item.submissions.excused));
}

function statusText(item: PlannerItem): string {
  const s = item.submissions;
  if (!s) return item.planner_override?.marked_complete ? "✓ done" : "";
  if (s.excused) return "excused";
  if (s.graded) return s.has_feedback ? "✓ graded (feedback)" : "✓ graded";
  if (s.submitted) return s.late ? "✓ submitted late" : "✓ submitted";
  if (s.missing) return "✗ MISSING";
  return "✗ not submitted";
}

function idText(item: PlannerItem): string {
  const course = item.course_id ? `course_id=${item.course_id} ` : "";
  switch (item.plannable_type) {
    case "assignment":
      return `${course}assignment_id=${item.plannable_id}`;
    case "quiz":
      return `${course}quiz_id=${item.plannable_id}${item.plannable.assignment_id ? ` assignment_id=${item.plannable.assignment_id}` : ""}`;
    case "discussion_topic":
    case "announcement":
      return `${course}topic_id=${item.plannable_id}`;
    default:
      return course.trim();
  }
}

export function registerPlannerTools(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "get_upcoming",
    description:
      "What's coming up: assignments, quizzes, graded discussions, peer reviews, class calendar events and personal planner notes in a date window, with submitted/missing status. Default: next 7 days, unfinished items only.",
    input: {
      days: z.number().int().min(1).max(120).optional().describe("Window length from start (default 7)"),
      start_date: z.string().optional().describe("ISO date; default now"),
      course_id: optionalCourseArg,
      include_done: z.boolean().optional().describe("Also show submitted/completed items"),
    },
    run: async ({ days, start_date, course_id, include_done }) => {
      const start = start_date ? new Date(start_date) : new Date();
      if (Number.isNaN(start.getTime())) throw new Error(`start_date "${start_date}" is not a date.`);
      const end = new Date(start.getTime() + (days ?? 7) * 86_400_000);
      const courseId = course_id === undefined ? undefined : await ctx.resolveCourseId(course_id);

      const items = await ctx.client.getPaginated<PlannerItem>("/planner/items", {
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        context_codes: courseId ? [`course_${courseId}`] : undefined,
      });

      const visible = items
        .filter((i) => include_done || !isDone(i))
        .sort((a, b) => a.plannable_date.localeCompare(b.plannable_date));
      const hiddenDone = items.length - visible.length;
      const header = `${fmtDate(start.toISOString(), ctx.timeZone)} → ${fmtDate(end.toISOString(), ctx.timeZone)}`;
      if (visible.length === 0) {
        return `Nothing ${include_done ? "" : "unfinished "}from ${header}.${hiddenDone ? ` (${hiddenDone} completed item(s) hidden)` : ""}`;
      }

      const lines = await Promise.all(
        visible.map(async (item) => {
          const p = item.plannable;
          const kind = KIND[item.plannable_type] ?? item.plannable_type;
          const when =
            item.plannable_type === "calendar_event" && p.start_at
              ? p.all_day ? fmtDate(p.start_at, ctx.timeZone).replace(/ \d.*$/, " (all day)") : `${fmtDate(p.start_at, ctx.timeZone)}${p.end_at ? `–${fmtDate(p.end_at, ctx.timeZone).replace(/^.* /, "")}` : ""}`
              : fmtDate(p.due_at ?? p.todo_date ?? item.plannable_date, ctx.timeZone);
          const label = item.course_id ? await ctx.courseLabel(item.course_id) : item.context_name ?? "personal";
          // Class-meeting events are usually titled with the course name already.
          const course = (p.title ?? "").toUpperCase().includes(label.toUpperCase()) ? "" : ` · ${label}`;
          const extras = [
            p.points_possible ? `${num(p.points_possible)}pts` : "",
            p.location_name ? oneLine(p.location_name, 60) : "",
            statusText(item),
          ].filter(Boolean);
          const note = item.plannable_type === "planner_note" && p.details ? `\n    ${oneLine(mdPreview(p.details, 200), 200)}` : "";
          const ids = idText(item);
          return `- ${when} · [${kind}] ${oneLine(p.title ?? "Untitled", 100)}${course}${extras.length ? ` · ${extras.join(" · ")}` : ""}${ids ? ` (${ids})` : ""}${note}`;
        }),
      );
      const footer = hiddenDone ? `\n(${hiddenDone} completed item(s) hidden; include_done=true to show)` : "";
      return `${visible.length} item(s), ${header}:\n${lines.join("\n")}${footer}`;
    },
  });
}
