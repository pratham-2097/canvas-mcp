import { z } from "zod";
import { CanvasApiError } from "../../canvas/client.js";
import type { ServerContext } from "../context.js";
import { fmtDate, mdPreview, num } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { courseArg } from "../shared.js";

interface Quiz {
  id: number;
  title: string;
  quiz_type: string;
  due_at: string | null;
  unlock_at: string | null;
  lock_at: string | null;
  time_limit: number | null;
  allowed_attempts: number;
  points_possible: number | null;
  question_count: number;
  assignment_id?: number;
  published?: boolean;
  locked_for_user?: boolean;
  lock_explanation?: string;
  description?: string | null;
  scoring_policy?: string;
  html_url: string;
}

interface QuizSubmission {
  attempt: number;
  score: number | null;
  kept_score: number | null;
  started_at: string | null;
  finished_at: string | null;
  workflow_state: string;
  attempts_left?: number;
}

interface Assignment {
  id: number;
  name: string;
  due_at: string | null;
  lock_at: string | null;
  unlock_at: string | null;
  points_possible: number | null;
  quiz_id?: number;
  is_quiz_assignment?: boolean;
  is_quiz_lti_assignment?: boolean;
  allowed_attempts?: number;
  html_url: string;
  description?: string | null;
  submission?: { workflow_state: string; score: number | null; submitted_at: string | null; attempt: number | null; missing?: boolean; late?: boolean; excused?: boolean };
}

function submissionText(sub: Assignment["submission"], points: number | null): string {
  if (!sub) return "no submission";
  if (sub.excused) return "excused";
  if (sub.score !== null && sub.score !== undefined) return `scored ${num(sub.score)}/${num(points)}`;
  if (sub.missing) return "MISSING";
  if (sub.submitted_at) return "submitted";
  return "not started";
}

const attemptsText = (n: number | undefined) => (n === undefined ? "" : n === -1 ? "unlimited attempts" : `${n} attempt${n === 1 ? "" : "s"}`);

export function registerQuizTools(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "get_quizzes",
    description:
      "Quizzes (Classic and New). Without quiz_id: list with due/lock dates, time limit, attempts, points and your status. With quiz_id (or a New Quiz's assignment_id): details and your attempts/scores. Never opens a quiz or reads questions.",
    input: { course_id: courseArg, quiz_id: z.number().optional() },
    run: async ({ course_id, quiz_id }) => {
      const courseId = await ctx.resolveCourseId(course_id);
      const tz = ctx.timeZone;

      if (quiz_id !== undefined) {
        const quiz = await ctx.client.get<Quiz>(`/courses/${courseId}/quizzes/${quiz_id}`).catch((err) => {
          if (err instanceof CanvasApiError && err.status === 404) return null;
          throw err;
        });
        if (!quiz) {
          // New Quizzes are only exposed to students as assignments.
          const a = await ctx.client.get<Assignment>(`/courses/${courseId}/assignments/${quiz_id}`, { include: ["submission"] });
          return [
            `# ${a.name} (New Quiz, assignment_id=${a.id})`,
            `due ${fmtDate(a.due_at, tz)} · available ${a.unlock_at ? fmtDate(a.unlock_at, tz) : "now"}–${a.lock_at ? fmtDate(a.lock_at, tz) : "open"} · ${num(a.points_possible)}pts · ${attemptsText(a.allowed_attempts)}`,
            `Your status: ${submissionText(a.submission, a.points_possible)}${a.submission?.attempt ? ` (attempt ${a.submission.attempt})` : ""}`,
            a.description ? `\n${mdPreview(a.description, 3000)}` : "",
            a.html_url,
          ].filter(Boolean).join("\n");
        }
        const subs = await ctx.client
          .get<{ quiz_submissions: QuizSubmission[] }>(`/courses/${courseId}/quizzes/${quiz_id}/submissions`)
          .then((r) => r.quiz_submissions)
          .catch(() => [] as QuizSubmission[]);
        const lines = [
          `# ${quiz.title} (quiz_id=${quiz.id}${quiz.assignment_id ? `, assignment_id=${quiz.assignment_id}` : ""})`,
          `type ${quiz.quiz_type} · ${num(quiz.points_possible)}pts · ${quiz.question_count} questions · ${quiz.time_limit ? `${quiz.time_limit} min` : "no time limit"} · ${attemptsText(quiz.allowed_attempts)}${quiz.scoring_policy ? ` (${quiz.scoring_policy.replace("_", " ")})` : ""}`,
          `due ${fmtDate(quiz.due_at, tz)} · opens ${quiz.unlock_at ? fmtDate(quiz.unlock_at, tz) : "now"} · closes ${quiz.lock_at ? fmtDate(quiz.lock_at, tz) : "never"}`,
        ];
        if (quiz.locked_for_user && quiz.lock_explanation) lines.push(`Locked: ${mdPreview(quiz.lock_explanation, 200)}`);
        if (subs.length) {
          lines.push("Your attempts:");
          for (const s of subs) {
            lines.push(`  - attempt ${s.attempt}: ${s.workflow_state}${s.score !== null ? ` · ${num(s.score)}/${num(quiz.points_possible)}` : ""}${s.finished_at ? ` · finished ${fmtDate(s.finished_at, tz)}` : ""}`);
          }
          const last = subs[subs.length - 1]!;
          if (last.kept_score !== null) lines.push(`Kept score: ${num(last.kept_score)}`);
          if (last.attempts_left !== undefined) lines.push(`Attempts left: ${last.attempts_left === -1 ? "unlimited" : last.attempts_left}`);
        } else {
          lines.push("Your attempts: none");
        }
        if (quiz.description) lines.push("", mdPreview(quiz.description, 3000));
        lines.push(quiz.html_url);
        return lines.join("\n");
      }

      const [classic, assignments] = await Promise.all([
        ctx.client.getPaginated<Quiz>(`/courses/${courseId}/quizzes`).catch((err: unknown) => err as Error),
        ctx.client.getPaginated<Assignment>(`/courses/${courseId}/assignments`, { include: ["submission"] }),
      ]);
      const byQuizId = new Map(assignments.filter((a) => a.quiz_id).map((a) => [a.quiz_id!, a]));
      const lines: string[] = [];

      if (classic instanceof Error) {
        const shells = assignments.filter((a) => a.is_quiz_assignment);
        lines.push(`Classic quiz list unavailable (${classic instanceof CanvasApiError ? classic.status : "error"}; Quizzes tab may be hidden).`);
        for (const a of shells) {
          lines.push(`- quiz_id=${a.quiz_id} ${a.name} · due ${fmtDate(a.due_at, ctx.timeZone)} · ${num(a.points_possible)}pts · ${submissionText(a.submission, a.points_possible)}`);
        }
      } else {
        const quizzes = classic.filter((q) => q.published !== false).sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9"));
        for (const q of quizzes) {
          const a = byQuizId.get(q.id);
          const meta = [
            `due ${fmtDate(q.due_at, ctx.timeZone)}`,
            q.time_limit ? `${q.time_limit}min` : "",
            attemptsText(q.allowed_attempts),
            `${num(q.points_possible)}pts`,
            q.quiz_type === "assignment" ? (a ? submissionText(a.submission, q.points_possible) : "") : q.quiz_type.replace("_", " "),
            q.locked_for_user ? "locked" : "",
          ].filter(Boolean);
          lines.push(`- quiz_id=${q.id} ${q.title} · ${meta.join(" · ")}`);
        }
      }
      const newQuizzes = assignments.filter((a) => a.is_quiz_lti_assignment);
      for (const a of newQuizzes) {
        lines.push(`- assignment_id=${a.id} ${a.name} (New Quiz) · due ${fmtDate(a.due_at, ctx.timeZone)} · ${num(a.points_possible)}pts · ${submissionText(a.submission, a.points_possible)}`);
      }
      return lines.length ? `Quizzes in ${await ctx.courseLabel(courseId)}:\n${lines.join("\n")}` : "No quizzes visible in this course.";
    },
  });
}
