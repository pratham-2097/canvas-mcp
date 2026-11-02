import { z } from "zod";
import * as gc from "../../grades/calc.js";
import type { ServerContext } from "../context.js";
import { shortCourseName } from "../context.js";
import { fmtDate, num } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { courseArg, optionalCourseArg } from "../shared.js";

type Json = Record<string, unknown>;

const MAX_TARGET_PERCENT = 200;
const MAX_LISTED_REMAINING = 15;

interface Enrollment {
  type?: string;
  role?: string;
  computed_current_score?: number | null;
  computed_final_score?: number | null;
  computed_current_grade?: string | null;
  has_grading_periods?: boolean;
  current_grading_period_title?: string | null;
  current_period_computed_current_score?: number | null;
}

interface CourseData {
  courseId: number;
  course: Json;
  groupsJson: Json[];
  groups: gc.GroupRules[];
  items: gc.GradedItem[];
  display: string;
}

interface LetterScheme {
  entries: gc.Scheme;
  source: string;
  pointsBased: boolean;
  scalingFactor: number | null;
  /** Canvas's default used as a stand-in: fine for context, never for a letter target. */
  isGuess: boolean;
}

function studentEnrollment(course: Json): Enrollment | null {
  const enrollments = Array.isArray(course.enrollments) ? (course.enrollments as Enrollment[]) : [];
  return enrollments.find((e) => e.type === "student" || e.type === "StudentEnrollment" || e.role === "StudentEnrollment") ?? null;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${gc.canvasRound(v).toFixed(2)}%`);

async function loadCourse(ctx: ServerContext, courseId: number, includes: string[]): Promise<CourseData> {
  const [course, groupsJson] = await Promise.all([
    ctx.client.get<Json>(`/courses/${courseId}`, { include: ["restrict_quantitative_data", ...includes] }),
    ctx.client.getPaginated<Json>(`/courses/${courseId}/assignment_groups`, { include: ["assignments", "submission"] }),
  ]);
  if (course.restrict_quantitative_data === true) {
    throw new Error("This course restricts quantitative grade data for students, so Canvas withholds the scores needed. Check Canvas for your grade.");
  }
  let model: { groups: gc.GroupRules[]; items: gc.GradedItem[] };
  try {
    model = gc.buildGradeModel(groupsJson);
  } catch (err) {
    if (err instanceof gc.MalformedGradeData) throw new Error(`Canvas returned grade data this tool can't trust (${err.message}); nothing computed.`);
    throw err;
  }
  const display = shortCourseName({ name: String(course.name ?? ""), course_code: String(course.course_code ?? courseId) });
  return { courseId, course, groupsJson, ...model, display };
}

async function resolveScheme(ctx: ServerContext, data: CourseData): Promise<LetterScheme> {
  const { course } = data;
  const scaling = typeof course.scaling_factor === "number" ? course.scaling_factor : null;
  const fromCourse = gc.parseGradingScheme(course.grading_scheme, scaling);
  const standardId = course.grading_standard_id;
  const enrollment = studentEnrollment(course);
  const base = { pointsBased: course.points_based_grading_scheme === true, scalingFactor: scaling };

  if (fromCourse) {
    const noStandard = standardId === null || standardId === undefined || standardId === "";
    const guess = noStandard && gc.sameScheme(fromCourse, gc.CANVAS_DEFAULT_SCHEME) && !enrollment?.computed_current_grade;
    const source = guess
      ? "Canvas default (course has no letter scheme enabled; letters are reference only)"
      : noStandard
        ? "course/institution default scheme returned by Canvas"
        : "the course's grading scheme";
    return { entries: fromCourse, source, isGuess: guess, ...base };
  }
  const safeId = gc.canvasId(standardId);
  if (safeId) {
    const standard = await ctx.client.get<Json>(`/courses/${data.courseId}/grading_standards/${safeId}`).catch(() => null);
    const parsed = standard ? gc.parseGradingScheme(standard.grading_scheme, scaling) : null;
    if (parsed) return { entries: parsed, source: "the course's grading standard", isGuess: false, ...base, pointsBased: standard?.points_based === true };
  }
  return { entries: gc.CANVAS_DEFAULT_SCHEME, source: "Canvas default as a fallback (course scheme unreadable; letters may differ)", isGuess: true, pointsBased: false, scalingFactor: null };
}

function letter(percent: number | null, scheme: LetterScheme): string {
  if (percent === null) return "n/a (nothing graded counts yet)";
  return `${pct(percent)} (${gc.letterForPercent(percent, scheme.entries, scheme.pointsBased, scheme.scalingFactor)})`;
}

function rulesText(group: Json): string {
  const rules = (group.rules ?? {}) as Json;
  const parts: string[] = [];
  if (Number(rules.drop_lowest)) parts.push(`drop lowest ${rules.drop_lowest}`);
  if (Number(rules.drop_highest)) parts.push(`drop highest ${rules.drop_highest}`);
  if (Array.isArray(rules.never_drop) && rules.never_drop.length) parts.push(`never drop ${rules.never_drop.length}`);
  return parts.join(", ");
}

function scoreText(a: Json, submission: Json | null): string {
  const points = typeof a.points_possible === "number" ? a.points_possible : 0;
  if (gc.gradeNotPosted(submission)) return `-/${num(points)}`;
  if (submission?.excused) return "excused";
  const score = typeof submission?.score === "number" ? submission.score : null;
  if (score === null) return `-/${num(points)}`;
  return points > 0 ? `${num(score)}/${num(points)} (${((score / points) * 100).toFixed(1)}%)` : `${num(score)} pts (extra credit)`;
}

function renderScores(data: CourseData, ctx: ServerContext): string {
  const { course } = data;
  const weighted = course.apply_assignment_group_weights === true;
  const enrollment = studentEnrollment(course);
  const lines = [
    `${data.display} (course_id=${data.courseId}) — ${weighted ? "weighted groups" : "total points"}` +
      (enrollment?.computed_current_score != null ? ` · Canvas current ${pct(enrollment.computed_current_score)}` : ""),
  ];
  for (const group of data.groupsJson) {
    const rules = rulesText(group);
    const weight = weighted ? ` · weight ${num(Number(group.group_weight ?? 0))}%` : "";
    lines.push(`\n## ${String(group.name ?? "Group")}${weight}${rules ? ` · ${rules}` : ""}`);
    const assignments = (group.assignments as Json[]) ?? [];
    if (assignments.length === 0) lines.push("(no assignments)");
    for (const a of assignments) {
      const submission = gc.ownSubmission(a);
      const status = gc.submissionStatuses(a, submission).join(", ");
      const due = a.due_at ? ` · due ${fmtDate(a.due_at as string, ctx.timeZone)}` : "";
      lines.push(`- ${a.id} ${String(a.name)} · ${scoreText(a, submission)} · ${status}${due}`);
    }
  }
  return lines.join("\n");
}

function groupLines(grade: gc.CourseGrade, groupNames: Map<string, string>, names: Map<string, string>): string[] {
  return grade.groups.map((g) => {
    const weight = grade.weighted ? ` (weight ${num(g.weight)}%)` : "";
    const value = g.possible > 0 ? `${num(g.score)}/${num(g.possible)} = ${((g.score / g.possible) * 100).toFixed(2)}%` : "nothing graded";
    const dropped = g.dropped.length ? ` · dropped: ${g.dropped.map((id) => names.get(id) ?? id).join(", ")}` : "";
    return `  - ${groupNames.get(g.groupId) ?? g.groupId}${weight}: ${value}${dropped}`;
  });
}

function renderScenarios(
  data: CourseData,
  scheme: LetterScheme,
  hypothetical: Record<string, number>,
  target: number | null,
  targetNote: string,
): string {
  const { course, groups, items } = data;
  const weighted = course.apply_assignment_group_weights === true;
  const groupNames = new Map(data.groupsJson.map((g) => [String(g.id), String(g.name ?? "Group")]));
  const names = new Map<string, string>();
  for (const g of data.groupsJson) for (const a of (g.assignments as Json[]) ?? []) names.set(String(a.id), String(a.name));

  const current = gc.calculateCourse(groups, items, weighted, false);
  const final = gc.calculateCourse(groups, items, weighted, true);
  const enrollment = studentEnrollment(course);
  const canvasCurrent = enrollment?.computed_current_score ?? null;
  const canvasFinal = enrollment?.computed_final_score ?? null;
  const disagrees = (computed: number | null, canvas: number) => computed === null || Math.abs(gc.canvasRound(computed) - canvas) > 0.01;
  const overrideSuspected =
    canvasCurrent !== null && canvasFinal !== null && Math.abs(canvasCurrent - canvasFinal) <= 0.005 &&
    current.percent !== null && final.percent !== null &&
    Math.abs(gc.canvasRound(current.percent) - gc.canvasRound(final.percent)) > 0.01 && disagrees(current.percent, canvasCurrent);

  const lines = [`Grade calculation: ${data.display} — ${weighted ? "weighted groups (rescaled if counted weights < 100%)" : "total points"}`];
  let anyDisagreement = false;

  lines.push(`Current (graded work only): ${letter(current.percent, scheme)}`);
  if (canvasCurrent !== null) {
    const canvasLetter = enrollment?.computed_current_grade ? ` (${enrollment.computed_current_grade})` : "";
    if (disagrees(current.percent, canvasCurrent)) {
      anyDisagreement = true;
      lines.push(`  ⚠ Canvas reports ${pct(canvasCurrent)}${canvasLetter} — DISAGREES.` + (overrideSuspected ? " Looks like an instructor final-grade override." : ""));
    } else {
      lines.push(`  ✓ matches Canvas (${pct(canvasCurrent)}${canvasLetter})`);
    }
  }
  lines.push(`Final (ungraded counted as 0): ${letter(final.percent, scheme)}` + (canvasFinal !== null && disagrees(final.percent, canvasFinal) ? ` ⚠ Canvas: ${pct(canvasFinal)}` : ""));
  if (canvasFinal !== null && disagrees(final.percent, canvasFinal)) anyDisagreement = true;
  lines.push("Groups:", ...groupLines(current, groupNames, names));

  let scenarioItems = items;
  if (Object.keys(hypothetical).length) {
    scenarioItems = gc.applyHypotheticalScores(items, hypothetical);
    const whatIf = gc.calculateCourse(groups, scenarioItems, weighted, false);
    const byId = new Map(items.map((i) => [i.assignmentId, i]));
    lines.push("\nWhat-if scores:");
    for (const [id, value] of Object.entries(hypothetical)) {
      const item = byId.get(id)!;
      const was = item.excused ? "was excused" : gc.isGraded(item) ? `was ${num(item.score)}` : "was ungraded";
      const note = !item.countsTowardGrade ? " (doesn't count toward grade)" : item.pointsPossible > 0 && value > item.pointsPossible ? " (extra credit)" : "";
      lines.push(`  - ${names.get(id) ?? id}: ${num(value)}/${num(item.pointsPossible)}, ${was}${note}`);
    }
    lines.push(`What-if current grade: ${letter(whatIf.percent, scheme)}`, ...groupLines(whatIf, groupNames, names));
  }

  if (target !== null) {
    const r = gc.requiredUniformPercent(groups, scenarioItems, weighted, target, MAX_TARGET_PERCENT);
    lines.push(`\nTarget ${pct(target)}${targetNote}${Object.keys(hypothetical).length ? " (on top of what-ifs)" : ""}:`);
    if (r.remainingIds.length) {
      const listed = r.remainingIds.slice(0, MAX_LISTED_REMAINING).map((id) => names.get(id) ?? id).join(", ");
      const more = r.remainingIds.length > MAX_LISTED_REMAINING ? `, +${r.remainingIds.length - MAX_LISTED_REMAINING} more` : "";
      lines.push(`  Remaining ungraded: ${r.remainingIds.length} (${num(r.remainingPoints)} pts): ${listed}${more}`);
      if (r.requiredPercent === 0) lines.push(`  Already secured: 0% on everything left still gives ${letter(r.projectedAtZero, scheme)}.`);
      else if (r.requiredPercent === null) {
        lines.push(r.nonMonotone ? "  Indeterminate: approximate search found no uniform score that works." : `  Not reachable: 100% on everything left gives ${letter(r.projectedAtFull, scheme)}.`);
      } else if (r.requiredPercent > 100) lines.push(`  Only with extra credit: need ${r.requiredPercent.toFixed(2)}% on every remaining assignment.`);
      else lines.push(`  Need ${r.requiredPercent.toFixed(2)}% (same %) on every remaining assignment.`);
      lines.push(`  Range: 0% left → ${letter(r.projectedAtZero, scheme)}; 100% left → ${letter(r.projectedAtFull, scheme)}.`);
      if (r.nonMonotone) lines.push("  Approximate: a group drops both lowest and highest, so higher scores can lower the grade.");
    } else {
      lines.push(`  Nothing ungraded remains: ${letter(r.projectedAtZero, scheme)} — target ${r.requiredPercent === 0 ? "met" : "not met"}.`);
    }
  }

  const caveats = ["Only assignments visible now are included; the instructor can still add work or change weights."];
  let hidden = 0;
  for (const g of data.groupsJson) for (const a of (g.assignments as Json[]) ?? []) if (gc.gradeNotPosted(gc.ownSubmission(a))) hidden++;
  if (hidden) caveats.push(`${hidden} graded-but-unposted assignment(s) count as ungraded (Canvas hides them too).`);
  const pending = items.filter((i) => i.pendingReview && !i.excused).length;
  if (pending) caveats.push(`${pending} submission(s) pending manual review are left out until graded.`);
  if (current.weighted && current.percent !== null && current.countedWeight < 100) {
    caveats.push(`Only ${num(current.countedWeight)}% of group weight has graded work; the grade can swing as other groups get graded.`);
  }
  if (course.hide_final_grades) caveats.push("The instructor hides totals, so this is an estimate Canvas doesn't show.");
  if (enrollment?.has_grading_periods) caveats.push("Course uses grading periods; period weighting is not reproduced.");
  if (anyDisagreement) caveats.push("Where this disagrees with Canvas, trust Canvas (overrides, periods, hidden or section-only work).");
  lines.push(`\nLetter scheme: ${scheme.source}`, "Caveats:", ...caveats.map((c) => `  - ${c}`));
  return lines.join("\n");
}

export function registerGradeTools(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "get_grades",
    description:
      "Grades. No course: current/final score for every course. With course: every assignment grouped by assignment group (weights, drop rules) with score, status (graded/missing/late/excused/unposted) and due date — also the way to list all of a course's assignments.",
    input: { course_id: optionalCourseArg },
    run: async ({ course_id }) => {
      if (course_id === undefined) {
        const courses = await ctx.client.getPaginated<Json>("/courses", { enrollment_state: "active", include: ["total_scores", "current_grading_period_scores"] });
        const lines = courses.flatMap((c) => {
          const e = studentEnrollment(c);
          if (!e) return [];
          const name = shortCourseName({ name: String(c.name), course_code: String(c.course_code) });
          if (e.computed_current_score == null) return [`- ${c.id} ${name}: no grade yet`];
          const letterGrade = e.computed_current_grade ? ` ${e.computed_current_grade}` : "";
          const period = e.has_grading_periods && e.current_period_computed_current_score != null
            ? ` · ${e.current_grading_period_title ?? "period"} ${pct(e.current_period_computed_current_score)}` : "";
          return [`- ${c.id} ${name}: ${pct(e.computed_current_score)}${letterGrade} (final w/ zeros ${pct(e.computed_final_score)})${period}`];
        });
        return lines.length ? `Current grades (Canvas-computed):\n${lines.join("\n")}` : "No student enrollments with grades.";
      }
      const data = await loadCourse(ctx, await ctx.resolveCourseId(course_id), ["total_scores"]);
      return renderScores(data, ctx);
    },
  });

  reg.add({
    name: "calculate_grade",
    description:
      "Recompute a course grade exactly like Canvas (weights, drop rules, excused), apply what-if scores, and find the % needed on remaining work to hit a target. Read-only.",
    input: {
      course_id: courseArg,
      what_if: z.record(z.string(), z.number().min(0)).optional().describe('Points by assignment id, e.g. {"123": 18}'),
      target_percent: z.number().min(0).max(MAX_TARGET_PERCENT).optional(),
      target_letter: z.string().max(40).optional().describe('e.g. "A-"'),
    },
    run: async ({ course_id, what_if, target_percent, target_letter }) => {
      if (target_percent !== undefined && target_letter !== undefined) throw new Error("Give target_percent or target_letter, not both.");
      const hypothetical: Record<string, number> = {};
      for (const [key, value] of Object.entries(what_if ?? {})) {
        const id = gc.canvasId(key);
        if (!id) throw new Error(`what_if key "${key}" is not an assignment id.`);
        hypothetical[id] = value;
      }
      const data = await loadCourse(ctx, await ctx.resolveCourseId(course_id), ["total_scores", "current_grading_period_scores", "grading_scheme"]);
      const known = new Set(data.items.map((i) => i.assignmentId));
      const unknown = Object.keys(hypothetical).filter((id) => !known.has(id));
      if (unknown.length) throw new Error(`what_if has assignment ids not in this course: ${unknown.join(", ")}. See get_grades for ids.`);

      const scheme = await resolveScheme(ctx, data);
      let target: number | null = target_percent ?? null;
      let targetNote = "";
      if (target_letter !== undefined) {
        if (scheme.isGuess) throw new Error(`Can't resolve a letter target: the course's real letter scheme is unknown (${scheme.source}). Use target_percent.`);
        const found = gc.findLetter(target_letter, scheme.entries);
        if (!found) throw new Error(`No letter "${target_letter}" in this scheme. Available: ${scheme.entries.map(([n]) => n).join(", ")}.`);
        [, target] = found;
        targetNote = ` (lower bound of ${found[0]})`;
      }
      return renderScenarios(data, scheme, hypothetical, target, targetNote);
    },
  });
}
