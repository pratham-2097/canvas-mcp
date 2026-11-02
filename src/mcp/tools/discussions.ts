import { z } from "zod";
import type { ServerContext } from "../context.js";
import { fmtDate, mdPreview, oneLine } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { optionalCourseArg } from "../shared.js";

interface Topic {
  id: number;
  title: string;
  message: string | null;
  html_url: string;
  posted_at: string | null;
  last_reply_at?: string | null;
  discussion_subentry_count?: number;
  unread_count?: number;
  read_state?: string;
  assignment_id?: number | null;
  user_name?: string | null;
  author?: { display_name?: string } | null;
  locked?: boolean;
  pinned?: boolean;
  require_initial_post?: boolean;
  todo_date?: string | null;
  context_code?: string;
}

interface ViewEntry {
  id: number;
  user_id?: number;
  parent_id?: number | null;
  message?: string;
  created_at: string;
  deleted?: boolean;
  replies?: ViewEntry[];
}

interface TopicView {
  participants: Array<{ id: number; display_name: string }>;
  view: ViewEntry[];
  unread_entries?: number[];
}

const ENTRY_CHARS = 700;

function author(t: Topic): string {
  return t.author?.display_name ?? t.user_name ?? "unknown";
}

export function registerDiscussionTools(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "get_discussions",
    description:
      "Discussion boards. Without topic_id: list a course's (or group's) topics with reply/unread counts. With topic_id: the prompt plus every reply as a thread. Also reads one announcement in full (announcements are topics).",
    input: {
      course_id: optionalCourseArg,
      group_id: z.number().optional().describe("For group discussions instead of a course"),
      topic_id: z.number().optional(),
      max_entries: z.number().int().min(1).max(300).optional().describe("Thread entries to show (default 60)"),
    },
    truncateHint: "pass a smaller max_entries",
    run: async ({ course_id, group_id, topic_id, max_entries }) => {
      if (course_id === undefined && group_id === undefined) throw new Error("Pass course_id or group_id.");
      const prefix = group_id !== undefined ? `/groups/${group_id}` : `/courses/${await ctx.resolveCourseId(course_id!)}`;
      const tz = ctx.timeZone;

      if (topic_id === undefined) {
        const topics = await ctx.client.getPaginated<Topic>(`${prefix}/discussion_topics`, { order_by: "recent_activity" });
        if (topics.length === 0) return "No discussion topics.";
        const lines = topics.map((t) => {
          const meta = [
            `by ${author(t)}`,
            `${t.discussion_subentry_count ?? 0} replies${t.unread_count ? ` (${t.unread_count} unread)` : ""}`,
            t.assignment_id ? `graded (assignment_id=${t.assignment_id})` : "",
            t.todo_date ? `to-do ${fmtDate(t.todo_date, tz)}` : "",
            t.last_reply_at ? `last reply ${fmtDate(t.last_reply_at, tz)}` : "",
            t.require_initial_post ? "post first to see replies" : "",
            t.locked ? "locked" : "",
          ].filter(Boolean);
          return `- topic_id=${t.id}${t.pinned ? " 📌" : ""} ${oneLine(t.title, 100)} · ${meta.join(" · ")}`;
        });
        return `${topics.length} topic(s):\n${lines.join("\n")}`;
      }

      const [topic, view] = await Promise.all([
        ctx.client.get<Topic>(`${prefix}/discussion_topics/${topic_id}`),
        ctx.client.get<TopicView>(`${prefix}/discussion_topics/${topic_id}/view`).catch(() => null),
      ]);
      const lines = [
        `# ${topic.title} (topic_id=${topic.id})`,
        `by ${author(topic)} · ${fmtDate(topic.posted_at, tz)}${topic.assignment_id ? ` · graded, assignment_id=${topic.assignment_id}` : ""}`,
        topic.html_url,
        "",
        mdPreview(topic.message, 4000) || "(no prompt text)",
      ];
      if (!view) {
        lines.push("", topic.require_initial_post ? "Replies hidden until you post (require_initial_post)." : "Replies unavailable.");
        return lines.join("\n");
      }
      const names = new Map(view.participants.map((p) => [p.id, p.display_name]));
      const unread = new Set(view.unread_entries ?? []);
      const limit = max_entries ?? 60;
      let shown = 0;
      let total = 0;
      const out: string[] = [];
      const walk = (entries: ViewEntry[], depth: number) => {
        for (const e of entries) {
          total++;
          if (shown < limit) {
            shown++;
            const indent = "  ".repeat(depth);
            const who = e.user_id ? names.get(e.user_id) ?? `user ${e.user_id}` : "unknown";
            const body = e.deleted ? "(deleted)" : oneLine(mdPreview(e.message, ENTRY_CHARS), ENTRY_CHARS);
            out.push(`${indent}- ${who} · ${fmtDate(e.created_at, tz)}${unread.has(e.id) ? " · NEW" : ""}: ${body}`);
          }
          if (e.replies?.length) walk(e.replies, depth + 1);
        }
      };
      walk(view.view, 0);
      lines.push("", `## Replies (${total})`, ...(out.length ? out : ["(none yet)"]));
      if (total > shown) lines.push(`…${total - shown} more; raise max_entries to see them.`);
      return lines.join("\n");
    },
  });

  reg.add({
    name: "list_announcements",
    description:
      "Announcements, newest first. Omit course_id for all courses at once. Previews only; read one in full with get_discussions(topic_id).",
    input: {
      course_id: optionalCourseArg,
      since: z.string().optional().describe("ISO date (default: 14 days ago)"),
      limit: z.number().int().min(1).max(100).optional().describe("default 20"),
    },
    run: async ({ course_id, since, limit }) => {
      const courses = course_id !== undefined ? [await ctx.resolveCourseId(course_id)] : (await ctx.listCourses()).map((c) => c.id);
      const start = since ? new Date(since) : new Date(Date.now() - 14 * 86_400_000);
      if (Number.isNaN(start.getTime())) throw new Error(`since "${since}" is not a date.`);
      const chunks: number[][] = [];
      for (let i = 0; i < courses.length; i += 10) chunks.push(courses.slice(i, i + 10));
      const results = await Promise.all(
        chunks.map((ids) =>
          ctx.client.getPaginated<Topic>("/announcements", {
            context_codes: ids.map((id) => `course_${id}`),
            start_date: start.toISOString(),
            end_date: new Date().toISOString(),
          }, 3),
        ),
      );
      const all = results.flat().sort((a, b) => (b.posted_at ?? "").localeCompare(a.posted_at ?? "")).slice(0, limit ?? 20);
      if (all.length === 0) return `No announcements since ${fmtDate(start.toISOString(), ctx.timeZone)}.`;
      const lines = await Promise.all(
        all.map(async (a) => {
          const cid = Number(a.context_code?.replace("course_", ""));
          const unread = a.read_state === "unread" ? " · UNREAD" : "";
          return `- ${fmtDate(a.posted_at, ctx.timeZone)} · ${await ctx.courseLabel(cid)} · ${oneLine(a.title, 100)}${unread} (course_id=${cid} topic_id=${a.id})\n  ${oneLine(mdPreview(a.message, 220), 220)}`;
        }),
      );
      return `${all.length} announcement(s):\n${lines.join("\n")}`;
    },
  });
}
