/**
 * Pure reproduction of Canvas's course-grade arithmetic (no I/O), ported
 * from vishalsachdev/canvas-mcp's core/grade_calc.py, which follows Canvas's
 * AssignmentGroupGradeCalculator / CourseGradeCalculator:
 *
 * - An assignment counts only when published, graded (not `not_graded`) and
 *   not `omit_from_final_grade`. Excused submissions are removed first.
 * - The current grade uses graded work only; the final grade counts every
 *   remaining assignment, ungraded ones as 0.
 * - Drop rules keep the subset with the best (or worst) combined
 *   score/possible ratio, not the lowest percentages. Solved with
 *   Dinkelbach's iteration, which reaches Canvas's optimum exactly.
 * - Weighted groups: groups with no points possible are left out; the rest
 *   contribute score/possible*weight, rescaled to 100 only when the counted
 *   weights total under 100.
 * - Unposted submissions (no posted_at) count as ungraded, as in Canvas's
 *   student-visible calculation.
 * - Scores are rounded the way Ruby rounds before a letter is assigned.
 *
 * Not reproduced: grading-period weighting, final grade overrides, and
 * anything a student cannot see. Callers say so.
 */

export const CANVAS_DEFAULT_SCHEME: ReadonlyArray<readonly [string, number]> = [
  ["A", 0.94], ["A-", 0.9], ["B+", 0.87], ["B", 0.84], ["B-", 0.8], ["C+", 0.77],
  ["C", 0.74], ["C-", 0.7], ["D+", 0.67], ["D", 0.64], ["D-", 0.61], ["F", 0],
];

const RATIO_EPSILON = 1e-12;
const NON_MONOTONE_GRID_STEP = 0.5;

function cRound(value: number): number {
  const magnitude = Math.abs(value);
  const floor = Math.floor(magnitude);
  const rounded = magnitude - floor >= 0.5 ? floor + 1 : floor;
  return value < 0 ? -rounded : rounded;
}

/** Ruby's Float#round(digits): half up on the decimal value, so 60.995 -> 61.0. */
export function canvasRound(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  let rounded = cRound(value * scale);
  if (value > 0 && (rounded + 0.5) / scale <= value) rounded += 1;
  else if (value < 0 && (rounded - 0.5) / scale >= value) rounded -= 1;
  return rounded / scale;
}

export interface GradedItem {
  assignmentId: string;
  groupId: string;
  pointsPossible: number;
  score: number | null;
  excused: boolean;
  pendingReview: boolean;
  countsTowardGrade: boolean;
}

export function isGraded(item: GradedItem): boolean {
  return item.score !== null && !item.pendingReview;
}

export interface GroupRules {
  groupId: string;
  weight: number;
  dropLowest: number;
  dropHighest: number;
  neverDrop: ReadonlySet<string>;
}

export interface GroupGrade {
  groupId: string;
  weight: number;
  score: number;
  possible: number;
  kept: string[];
  dropped: string[];
}

export interface CourseGrade {
  percent: number | null;
  weighted: boolean;
  groups: GroupGrade[];
  /** Weighted: total weight of groups that counted. */
  countedWeight: number;
}

interface Entry {
  assignmentId: string;
  score: number;
  total: number;
  order: number;
}

function ratio(entries: Entry[], extraScore: number, extraTotal: number): number | null {
  const total = entries.reduce((s, e) => s + e.total, 0) + extraTotal;
  if (total <= 0) return null;
  return (entries.reduce((s, e) => s + e.score, 0) + extraScore) / total;
}

/** Stable sort (Array.prototype.sort is stable in ES2019+). */
function keepByRatio(candidates: Entry[], cantDrop: Entry[], keepCount: number, maximize: boolean): Entry[] {
  keepCount = Math.max(1, keepCount);
  if (candidates.length <= keepCount) return [...candidates];
  const cantScore = cantDrop.reduce((s, e) => s + e.score, 0);
  const cantTotal = cantDrop.reduce((s, e) => s + e.total, 0);

  const choose = (q: number) =>
    [...candidates]
      .sort((a, b) => {
        const ka = a.score - q * a.total;
        const kb = b.score - q * b.total;
        return maximize ? kb - ka : ka - kb;
      })
      .slice(0, keepCount);

  const start = ratio(candidates, cantScore, cantTotal);
  let chosen = choose(start ?? 0);
  let q = ratio(chosen, cantScore, cantTotal);
  for (let i = 0; i < 1000 && q !== null; i++) {
    const next = choose(q);
    const nextQ = ratio(next, cantScore, cantTotal);
    if (nextQ === null) {
      chosen = next;
      break;
    }
    const improved = maximize ? nextQ > q + RATIO_EPSILON : nextQ < q - RATIO_EPSILON;
    if (!improved) break;
    chosen = next;
    q = nextQ;
  }
  return chosen.sort((a, b) => a.order - b.order);
}

function idSortKey(id: string): [number, string] {
  return /^\d+$/.test(id) ? [id.length, id] : [1 << 30, id];
}

export function dropAssignments(
  entries: Entry[],
  dropLowest = 0,
  dropHighest = 0,
  neverDrop: ReadonlySet<string> = new Set(),
): { kept: Entry[]; dropped: Entry[] } {
  dropLowest = Math.max(0, Math.trunc(dropLowest || 0));
  dropHighest = Math.max(0, Math.trunc(dropHighest || 0));
  if (!dropLowest && !dropHighest) return { kept: [...entries], dropped: [] };

  const cant = entries.filter((e) => neverDrop.has(e.assignmentId));
  const droppable = entries.filter((e) => !neverDrop.has(e.assignmentId));
  if (droppable.length === 0) return { kept: [...entries], dropped: [] };

  const n = droppable.length;
  dropLowest = Math.min(dropLowest, n - 1);
  if (dropLowest + dropHighest >= n) dropHighest = 0;
  const keepHighest = n - dropLowest;
  const keepLowest = keepHighest - dropHighest;

  let kept: Entry[];
  if (droppable.some((e) => e.total > 0)) {
    const keptHigh = keepByRatio(droppable, cant, keepHighest, true);
    kept = keepByRatio(keptHigh, cant, keepLowest, false);
  } else {
    const ordered = [...droppable].sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const [la, sa] = idSortKey(a.assignmentId);
      const [lb, sb] = idSortKey(b.assignmentId);
      return la !== lb ? la - lb : sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    kept = ordered.slice(ordered.length - keepHighest).slice(0, keepLowest);
  }

  const keptOrders = new Set(kept.map((e) => e.order));
  return {
    kept: [...kept, ...cant].sort((a, b) => a.order - b.order),
    dropped: droppable.filter((e) => !keptOrders.has(e.order)),
  };
}

export function calculateGroup(rules: GroupRules, items: GradedItem[], includeUngraded: boolean): GroupGrade {
  const entries: Entry[] = [];
  items.forEach((item, order) => {
    if (item.groupId !== rules.groupId || !item.countsTowardGrade || item.excused) return;
    if (!includeUngraded && !isGraded(item)) return;
    entries.push({ assignmentId: item.assignmentId, score: item.score ?? 0, total: Math.max(item.pointsPossible, 0), order });
  });
  const { kept, dropped } = dropAssignments(entries, rules.dropLowest, rules.dropHighest, rules.neverDrop);
  return {
    groupId: rules.groupId,
    weight: rules.weight || 0,
    score: kept.reduce((s, e) => s + e.score, 0),
    possible: kept.reduce((s, e) => s + e.total, 0),
    kept: kept.map((e) => e.assignmentId),
    dropped: dropped.map((e) => e.assignmentId),
  };
}

export function calculateCourse(
  groups: GroupRules[],
  items: GradedItem[],
  weighted: boolean,
  includeUngraded = false,
): CourseGrade {
  const groupGrades = groups.map((g) => calculateGroup(g, items, includeUngraded));
  if (weighted) {
    const relevant = groupGrades.filter((g) => g.possible > 0);
    const fullWeight = relevant.reduce((s, g) => s + g.weight, 0);
    if (fullWeight === 0) return { percent: null, weighted: true, groups: groupGrades, countedWeight: 0 };
    let total = relevant.reduce((s, g) => s + (g.score / g.possible) * g.weight, 0);
    if (fullWeight < 100) total = (total * 100) / fullWeight;
    return { percent: total, weighted: true, groups: groupGrades, countedWeight: fullWeight };
  }
  const score = groupGrades.reduce((s, g) => s + g.score, 0);
  const possible = groupGrades.reduce((s, g) => s + g.possible, 0);
  return { percent: possible > 0 ? (score / possible) * 100 : null, weighted: false, groups: groupGrades, countedWeight: 0 };
}

export function applyHypotheticalScores(items: GradedItem[], scores: Record<string, number>): GradedItem[] {
  return items.map((item) =>
    item.assignmentId in scores
      ? { ...item, score: scores[item.assignmentId]!, excused: false, pendingReview: false }
      : item,
  );
}

export function remainingItems(items: GradedItem[]): GradedItem[] {
  return items.filter((i) => i.countsTowardGrade && !i.excused && !isGraded(i) && i.pointsPossible > 0);
}

export function projectUniform(groups: GroupRules[], items: GradedItem[], weighted: boolean, percentOnRemaining: number): CourseGrade {
  const remaining = new Set(remainingItems(items).map((i) => i.assignmentId));
  const fraction = percentOnRemaining / 100;
  const filled = items.map((item) =>
    remaining.has(item.assignmentId) ? { ...item, score: fraction * item.pointsPossible, pendingReview: false } : item,
  );
  return calculateCourse(groups, filled, weighted, false);
}

export interface TargetResult {
  targetPercent: number;
  remainingIds: string[];
  remainingPoints: number;
  /** Lowest uniform percent (0.01 resolution) reaching the target, or null. */
  requiredPercent: number | null;
  projectedAtZero: number | null;
  projectedAtFull: number | null;
  /** A group with remaining work drops both lowest and highest: answer is approximate. */
  nonMonotone: boolean;
}

const meets = (percent: number | null, target: number) => percent !== null && percent >= target - 1e-9;

export function requiredUniformPercent(
  groups: GroupRules[],
  items: GradedItem[],
  weighted: boolean,
  targetPercent: number,
  maxPercent = 200,
): TargetResult {
  const remaining = remainingItems(items);
  const remainingGroups = new Set(remaining.map((i) => i.groupId));
  const nonMonotone = groups.some((g) => g.dropLowest > 0 && g.dropHighest > 0 && remainingGroups.has(g.groupId));
  const gradeAt = (p: number) => projectUniform(groups, items, weighted, p).percent;
  const atZero = gradeAt(0);
  const atFull = gradeAt(100);
  const result = (requiredPercent: number | null): TargetResult => ({
    targetPercent,
    remainingIds: remaining.map((i) => i.assignmentId),
    remainingPoints: remaining.reduce((s, i) => s + i.pointsPossible, 0),
    requiredPercent,
    projectedAtZero: atZero,
    projectedAtFull: atFull,
    nonMonotone,
  });

  if (remaining.length === 0) return result(meets(atZero, targetPercent) ? 0 : null);
  if (meets(atZero, targetPercent)) return result(0);
  if (nonMonotone) return result(scanNonMonotone(gradeAt, targetPercent, maxPercent));

  let low: number;
  let high: number;
  if (meets(atFull, targetPercent)) [low, high] = [0, 100];
  else if (meets(gradeAt(maxPercent), targetPercent)) [low, high] = [100, maxPercent];
  else return result(null);

  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (meets(gradeAt(mid), targetPercent)) high = mid;
    else low = mid;
  }
  let required = Math.ceil(high * 100 - 1e-9) / 100;
  while (!meets(gradeAt(required), targetPercent) && required < maxPercent) {
    required = Math.round((required + 0.01) * 100) / 100;
  }
  return result(meets(gradeAt(required), targetPercent) ? required : null);
}

function scanNonMonotone(gradeAt: (p: number) => number | null, target: number, maxPercent: number): number | null {
  const steps = Math.ceil(maxPercent / NON_MONOTONE_GRID_STEP);
  let previous = 0;
  for (let i = 1; i <= steps; i++) {
    const point = Math.min(Math.round(i * NON_MONOTONE_GRID_STEP * 100) / 100, maxPercent);
    if (meets(gradeAt(point), target)) {
      for (let j = 1; j < Math.round((point - previous) * 100); j++) {
        const candidate = Math.round((previous + j / 100) * 100) / 100;
        if (meets(gradeAt(candidate), target)) return candidate;
      }
      return point;
    }
    previous = point;
  }
  return null;
}

// ---------------------------------------------------------------- letters

export type Scheme = ReadonlyArray<readonly [string, number]>;

/** Accepts [["A",0.94],...] or [{name,value},...]; converts points-based bounds. Null if not a scheme. */
export function parseGradingScheme(data: unknown, scalingFactor?: number | null): Scheme | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  let entries: Array<[string, number]> = [];
  for (const row of data) {
    let name: unknown;
    let value: unknown;
    if (Array.isArray(row) && row.length === 2) [name, value] = row;
    else if (row && typeof row === "object") ({ name, value } = row as { name: unknown; value: unknown });
    else return null;
    if (typeof name !== "string" || !name.trim()) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    entries.push([name, value]);
  }
  if (scalingFactor && scalingFactor > 1 && entries.some(([, v]) => v > 1)) {
    entries = entries.map(([n, v]) => [n, v / scalingFactor]);
  }
  if (entries.some(([, v]) => v > 1 + 1e-9)) return null;
  return entries.sort((a, b) => b[1] - a[1]);
}

/** Canvas GradingStandard#scale_score: points-based schemes compare after a 2-decimal round trip in points. */
function scalePointsBased(score: number, scalingFactor: number): number {
  if (scalingFactor === 100 || scalingFactor <= 0) return score;
  const scaled = canvasRound(score / (100 / scalingFactor));
  return canvasRound((scaled / scalingFactor) * 100);
}

export function letterForPercent(
  percent: number | null,
  scheme: Scheme,
  pointsBased = false,
  scalingFactor: number | null = null,
): string | null {
  if (percent === null || scheme.length === 0) return null;
  let score = Math.max(canvasRound(percent), 0);
  if (pointsBased && scalingFactor !== null && Number.isFinite(scalingFactor)) score = scalePointsBased(score, scalingFactor);
  for (const [name, lower] of scheme) {
    if (score >= Math.round(lower * 100 * 1e6) / 1e6 - 1e-9) return name;
  }
  return scheme[scheme.length - 1]![0];
}

export function sameScheme(a: Scheme | null, b: Scheme | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every(([n, v], i) => n === b[i]![0] && Math.abs(v - b[i]![1]) < 1e-9);
}

/** [scheme name, lower-bound percent] for a letter: exact match, else a unique case-insensitive one. */
export function findLetter(letter: string, scheme: Scheme): [string, number] | null {
  const wanted = letter.trim();
  const toPct = (v: number) => Math.round(v * 100 * 1e6) / 1e6;
  for (const [name, lower] of scheme) if (name === wanted) return [name, toPct(lower)];
  const folded = scheme.filter(([name]) => name.trim().toLowerCase() === wanted.toLowerCase());
  return folded.length === 1 ? [folded[0]![0], toPct(folded[0]![1])] : null;
}

// ---------------------------------------------------------------- Canvas JSON -> model

export class MalformedGradeData extends Error {}

type Json = Record<string, unknown>;

function asNumber(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function canvasId(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) ? text : null;
}

export function ownSubmission(assignment: Json): Json | null {
  const s = assignment.submission;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Json) : null;
}

/** Canvas's student-visible grade ignores submissions without posted_at (only when the key is sent). */
export function isUnposted(submission: Json | null): boolean {
  return submission !== null && "posted_at" in submission && !submission.posted_at;
}

/** Graded or excused, but hidden from the student until posted. */
export function gradeNotPosted(submission: Json | null): boolean {
  if (!submission) return false;
  if ("posted_at" in submission) {
    return isUnposted(submission) && (Boolean(submission.excused) || submission.workflow_state === "graded");
  }
  return submission.workflow_state === "graded" && asNumber(submission.score) === null && !submission.excused;
}

export function assignmentCounts(a: Json): boolean {
  if (a.omit_from_final_grade) return false;
  if (a.grading_type === "not_graded") return false;
  if (Array.isArray(a.submission_types) && a.submission_types.includes("not_graded")) return false;
  if (a.workflow_state === "unpublished" || a.published === false) return false;
  return true;
}

/** Plain-language status labels for one of the caller's assignments. */
export function submissionStatuses(a: Json, submission: Json | null): string[] {
  const labels: string[] = [];
  if (a.omit_from_final_grade) labels.push("not counted");
  if (a.grading_type === "not_graded" || (Array.isArray(a.submission_types) && a.submission_types.includes("not_graded"))) {
    labels.push("not graded");
  }
  if (!submission) {
    labels.push("no submission record");
    return labels;
  }
  const score = asNumber(submission.score);
  if (gradeNotPosted(submission)) labels.push("grade not posted yet");
  else if (submission.excused) labels.push("excused");
  else if (submission.workflow_state === "pending_review") labels.push("pending review");
  else if (score !== null) labels.push("graded");
  else if (submission.missing) labels.push("missing");
  else if (submission.submitted_at) labels.push("submitted, not graded");
  else labels.push("unsubmitted");
  if (score !== null && submission.missing) labels.push("marked missing");
  if (submission.late) labels.push("late");
  const deducted = asNumber(submission.points_deducted);
  if (deducted) labels.push(`late penalty -${deducted}`);
  return labels;
}

function checkedNumber(value: unknown, label: string, minimum?: number): number | null {
  if (value === null || value === undefined) return null;
  const n = asNumber(value);
  if (n === null) throw new MalformedGradeData(`${label} is not a number`);
  if (minimum !== undefined && n < minimum) throw new MalformedGradeData(`${label} is below ${minimum}`);
  return n;
}

function dropCount(rules: Json, key: string, groupId: string): number {
  const value = rules[key];
  if (value === null || value === undefined) return 0;
  const n = asNumber(value);
  if (n === null || n < 0 || n !== Math.trunc(n)) throw new MalformedGradeData(`group ${groupId} has an unreadable ${key} rule`);
  return n;
}

/**
 * Turns /assignment_groups?include[]=assignments&include[]=submission into
 * the model. Throws MalformedGradeData rather than silently skipping an
 * entry: a grade computed from a shortened list would look authoritative
 * and be wrong.
 */
export function buildGradeModel(groupsJson: unknown[]): { groups: GroupRules[]; items: GradedItem[] } {
  const groups: GroupRules[] = [];
  const items: GradedItem[] = [];
  const seenGroups = new Set<string>();
  const seenAssignments = new Set<string>();
  for (const raw of groupsJson) {
    if (!raw || typeof raw !== "object") throw new MalformedGradeData("an assignment group is not an object");
    const group = raw as Json;
    const groupId = canvasId(group.id);
    if (!groupId) throw new MalformedGradeData("an assignment group has no numeric id");
    if (seenGroups.has(groupId)) throw new MalformedGradeData(`group ${groupId} appears twice`);
    seenGroups.add(groupId);
    const rules = (group.rules ?? {}) as Json;
    if (typeof rules !== "object" || Array.isArray(rules)) throw new MalformedGradeData(`group ${groupId} has unreadable rules`);
    const neverDropRaw = rules.never_drop ?? [];
    if (!Array.isArray(neverDropRaw)) throw new MalformedGradeData(`group ${groupId} has an unreadable never_drop rule`);
    const neverDrop = new Set<string>();
    for (const entry of neverDropRaw) {
      const id = canvasId(entry);
      if (!id) throw new MalformedGradeData(`group ${groupId} has a bad never_drop entry`);
      neverDrop.add(id);
    }
    groups.push({
      groupId,
      weight: checkedNumber(group.group_weight, `group ${groupId} weight`, 0) ?? 0,
      dropLowest: dropCount(rules, "drop_lowest", groupId),
      dropHighest: dropCount(rules, "drop_highest", groupId),
      neverDrop,
    });
    if (!Array.isArray(group.assignments)) throw new MalformedGradeData(`group ${groupId} did not list its assignments`);
    for (const rawA of group.assignments) {
      if (!rawA || typeof rawA !== "object") throw new MalformedGradeData(`an assignment in group ${groupId} is not an object`);
      const a = rawA as Json;
      const assignmentId = canvasId(a.id);
      if (!assignmentId) throw new MalformedGradeData(`an assignment in group ${groupId} has no numeric id`);
      if (seenAssignments.has(assignmentId)) throw new MalformedGradeData(`assignment ${assignmentId} appears twice`);
      seenAssignments.add(assignmentId);
      if (a.submission !== null && a.submission !== undefined && (typeof a.submission !== "object" || Array.isArray(a.submission))) {
        throw new MalformedGradeData(`assignment ${assignmentId} returned submissions as a list (observer token?)`);
      }
      const submission = ownSubmission(a);
      const unposted = isUnposted(submission);
      const rawScore = submission ? checkedNumber(submission.score, `assignment ${assignmentId} score`) : null;
      items.push({
        assignmentId,
        groupId,
        pointsPossible: checkedNumber(a.points_possible, `assignment ${assignmentId} points_possible`, 0) ?? 0,
        score: unposted ? null : rawScore,
        excused: Boolean(submission?.excused) && !unposted,
        pendingReview: submission?.workflow_state === "pending_review",
        countsTowardGrade: assignmentCounts(a),
      });
    }
  }
  return { groups, items };
}
