import { z } from "zod";
import { getAssignment, listCourseAssignments } from "../../canvas/endpoints.js";
import { extractLinks, htmlToMarkdown, type ResolvedLink } from "../../canvas/html.js";
import type { CanvasAssignment, CanvasRubricCriterion, CanvasSubmissionDetail } from "../../canvas/types.js";
import type { ServerContext } from "../context.js";
import { fmtDate, mapLimit, num, oneLine } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { courseArg, optionalCourseArg } from "../shared.js";

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

/** One line per criterion, ratings inline: far smaller than the raw JSON and just as usable. */
export function renderRubric(rubric: CanvasRubricCriterion[] | undefined, assessment?: CanvasSubmissionDetail["rubric_assessment"]): string {
  if (!rubric?.length) return "";
  const lines = ["## Rubric"];
  for (const c of rubric) {
    const ratings = (c.ratings ?? []).map((r) => `${num(r.points)} ${oneLine(r.description, 40)}`).join(" | ");
    const got = assessment?.[c.id];
    const score = got && got.points !== null && got.points !== undefined ? ` → you got ${num(got.points)}` : "";
    const detail = c.long_description ? ` — ${oneLine(htmlToMarkdown(c.long_description), 200)}` : "";
    lines.push(`- ${oneLine(c.description, 80)} (${num(c.points)} pts)${score}${detail}${ratings ? `\n  ratings: ${ratings}` : ""}${got?.comments ? `\n  grader: ${oneLine(got.comments, 300)}` : ""}`);
  }
  return lines.join("\n");
}

export function renderLinks(links: ResolvedLink[]): string {
  if (links.length === 0) return "";
  const seen = new Set<string>();
  const lines = links
    .filter((l) => !seen.has(l.href) && seen.add(l.href))
    .map((l) => {
      if (l.kind === "file") return `- file: ${l.text} (file_id=${l.fileId})`;
      if (l.kind === "page") return `- page: ${l.text} (page_url=${l.pageUrl})`;
      return `- external: ${l.text} ${l.href}`;
    });
  return ["## Links in description", ...lines].join("\n");
}

export function assignmentHeader(a: CanvasAssignment, courseId: number, timeZone: string): string {
  const attempts = a.allowed_attempts && a.allowed_attempts > 0 ? ` · ${a.allowed_attempts} attempt(s) allowed` : "";
  const window = a.unlock_at || a.lock_at ? `\navailable ${a.unlock_at ? fmtDate(a.unlock_at, timeZone) : "now"} → ${a.lock_at ? fmtDate(a.lock_at, timeZone) : "no close date"}` : "";
  const types = a.submission_types.join(", ") + (a.allowed_extensions?.length ? ` (${a.allowed_extensions.join(", ")})` : "");
  return [
    `# ${a.name}`,
    `course_id=${courseId} assignment_id=${a.id} · ${a.html_url}`,
    `due ${fmtDate(a.due_at, timeZone)} · ${num(a.points_possible)} pts · submit via ${types}${attempts}${a.peer_reviews ? " · peer reviewed" : ""}${a.group_category_id ? " · group assignment" : ""}${window}`,
    a.locked_for_user && a.lock_explanation ? `Locked: ${oneLine(htmlToMarkdown(a.lock_explanation), 200)}` : "",
  ].filter(Boolean).join("\n");
}

function submissionSection(s: CanvasSubmissionDetail | null, points: number | null, timeZone: string): string {
  if (!s) return "## Your submission\n(not visible)";
  const status = s.excused ? "excused"
    : s.score !== null && s.score !== undefined ? `graded ${num(s.score)}/${num(points)}${s.grade && s.grade !== String(s.score) ? ` (${s.grade})` : ""}`
    : s.workflow_state === "graded" && !s.posted_at ? "graded, not posted yet"
    : s.submitted_at ? `submitted ${fmtDate(s.submitted_at, timeZone)}, not graded`
    : s.missing ? "MISSING" : "not submitted";
  const flags = [s.late ? "late" : "", s.points_deducted ? `-${num(s.points_deducted)} late penalty` : "", s.attempt ? `attempt ${s.attempt}` : ""].filter(Boolean).join(" · ");
  const comments = (s.submission_comments ?? []).map((c) => `- ${c.author_name} (${fmtDate(c.created_at, timeZone)}): ${oneLine(c.comment, 500)}`);
  return ["## Your submission", `${status}${flags ? ` · ${flags}` : ""}`, ...(comments.length ? ["Comments:", ...comments] : [])].join("\n");
}

export async function loadAssignmentWithSubmission(ctx: ServerContext, courseId: number, assignmentId: number) {
  const [a, submission] = await Promise.all([
    getAssignment(ctx.client, courseId, assignmentId),
    ctx.client
      .get<CanvasSubmissionDetail>(`/courses/${courseId}/assignments/${assignmentId}/submissions/self`, { include: ["submission_comments", "rubric_assessment"] })
      .catch(() => null),
  ]);
  return { a, submission };
}

export function registerAssignmentTools(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "find_assignment",
    description: "Fuzzy-find an assignment by name (e.g. 'Project 1') across all courses or one. Returns ids for get_assignment / gather_assignment_context.",
    input: { query: z.string(), course_id: optionalCourseArg },
    run: async ({ query, course_id }) => {
      const courseIds = course_id !== undefined ? [await ctx.resolveCourseId(course_id)] : (await ctx.listCourses()).map((c) => c.id);
      const perCourse = await mapLimit(courseIds, 6, async (id) => {
        const assignments = await listCourseAssignments(ctx.client, id).catch(() => [] as CanvasAssignment[]);
        return assignments.map((a) => ({ score: similarity(query, a.name), a, courseId: id }));
      });
      const top = perCourse.flat().filter((c) => c.score > 20).sort((x, y) => y.score - x.score).slice(0, 10);
      if (top.length === 0) return `No assignments matched "${query}".`;
      const lines = await Promise.all(
        top.map(async ({ a, courseId }) => `- ${a.name} · ${await ctx.courseLabel(courseId)} · due ${fmtDate(a.due_at, ctx.timeZone)} (course_id=${courseId} assignment_id=${a.id})`),
      );
      return `${top.length} match(es) for "${query}":\n${lines.join("\n")}`;
    },
  });

  reg.add({
    name: "get_assignment",
    description: "One assignment in full: description, dates, rubric, links, plus your submission status, score, attempts, grader comments and rubric scores.",
    input: { course_id: courseArg, assignment_id: z.number() },
    run: async ({ course_id, assignment_id }) => {
      const courseId = await ctx.resolveCourseId(course_id);
      const { a, submission } = await loadAssignmentWithSubmission(ctx, courseId, assignment_id);
      return [
        assignmentHeader(a, courseId, ctx.timeZone),
        submissionSection(submission, a.points_possible, ctx.timeZone),
        `## Description\n${htmlToMarkdown(a.description ?? "") || "(no description)"}`,
        renderLinks(extractLinks(a.description ?? "")),
        renderRubric(a.rubric, submission?.rubric_assessment),
      ].filter(Boolean).join("\n\n");
    },
  });
}
