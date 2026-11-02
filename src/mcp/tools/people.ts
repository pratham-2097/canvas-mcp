import { z } from "zod";
import type { ServerContext } from "../context.js";
import { fmtDate, mdPreview, num, oneLine } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { courseArg } from "../shared.js";

interface Conversation {
  id: number;
  subject: string | null;
  workflow_state: string;
  last_message: string | null;
  last_message_at: string | null;
  message_count: number;
  starred?: boolean;
  participants: Array<{ id: number; name: string }>;
  context_name?: string;
  messages?: Array<{
    id: number;
    author_id: number;
    created_at: string;
    body: string;
    attachments?: Array<{ display_name: string; id: number }>;
  }>;
}

interface Group {
  id: number;
  name: string;
  members_count: number;
  context_name?: string;
  course_id?: number;
  concluded?: boolean;
  description?: string | null;
}

interface User {
  id: number;
  name: string;
  email?: string;
  pronouns?: string | null;
  enrollments?: Array<{ type: string; role: string }>;
}

interface ActivityItem {
  id: number;
  type: string;
  title: string | null;
  message?: string | null;
  created_at: string;
  updated_at: string;
  read_state?: boolean;
  course_id?: number;
  group_id?: number;
  html_url?: string;
  score?: number | null;
  grade?: string | null;
  assignment?: { name?: string; points_possible?: number | null };
  submission_comments?: Array<{ author_name?: string; comment: string }>;
}

const ROLE_TYPES: Record<string, string[]> = {
  staff: ["teacher", "ta"],
  teacher: ["teacher"],
  ta: ["ta"],
  student: ["student"],
  all: [],
};

export function registerPeopleTools(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "get_inbox",
    description:
      "Canvas Inbox. Without conversation_id: recent conversations with unread count. With conversation_id: the full message thread. Never marks anything read.",
    input: {
      conversation_id: z.number().optional(),
      filter: z.enum(["unread", "starred", "sent", "archived"]).optional(),
      limit: z.number().int().min(1).max(50).optional().describe("default 15"),
    },
    run: async ({ conversation_id, filter, limit }) => {
      const tz = ctx.timeZone;
      if (conversation_id !== undefined) {
        // auto_mark_as_read=false keeps this tool read-only: by default Canvas
        // marks a conversation read when it is fetched.
        const c = await ctx.client.get<Conversation>(`/conversations/${conversation_id}`, { auto_mark_as_read: false });
        const names = new Map(c.participants.map((p) => [p.id, p.name]));
        const messages = [...(c.messages ?? [])].reverse();
        const lines = [
          `# ${c.subject || "(no subject)"} (conversation_id=${c.id})`,
          `${c.context_name ?? ""} · with ${c.participants.map((p) => p.name).join(", ")}`,
        ];
        for (const m of messages) {
          const files = m.attachments?.length ? `\n  attachments: ${m.attachments.map((a) => `${a.display_name} (file_id=${a.id})`).join(", ")}` : "";
          lines.push(`\n## ${names.get(m.author_id) ?? `user ${m.author_id}`} · ${fmtDate(m.created_at, tz)}\n${m.body.trim().slice(0, 3000)}${files}`);
        }
        return lines.join("\n");
      }
      const [list, unread] = await Promise.all([
        ctx.client.get<Conversation[]>("/conversations", { scope: filter, per_page: limit ?? 15 }),
        ctx.client.get<{ unread_count: string | number }>("/conversations/unread_count").catch(() => null),
      ]);
      const header = unread ? `${unread.unread_count} unread conversation(s) total.` : "";
      if (list.length === 0) return `${header}\nNo conversations${filter ? ` (${filter})` : ""}.`.trim();
      const lines = list.map((c) => {
        const flag = c.workflow_state === "unread" ? "UNREAD " : "";
        const who = c.participants.slice(0, 4).map((p) => p.name).join(", ") + (c.participants.length > 4 ? ` +${c.participants.length - 4}` : "");
        return `- conversation_id=${c.id} ${flag}${oneLine(c.subject || "(no subject)", 80)} · ${who} · ${c.context_name ? `${oneLine(c.context_name, 50)} · ` : ""}${fmtDate(c.last_message_at, tz)} · ${c.message_count} msg\n  ${oneLine(c.last_message ?? "", 160)}`;
      });
      return `${header}\n${lines.join("\n")}`.trim();
    },
  });

  reg.add({
    name: "get_groups",
    description: "Your Canvas groups (project teams). With group_id: its members. Group files: list_files(group_id); group discussions: get_discussions(group_id).",
    input: { group_id: z.number().optional(), include_concluded: z.boolean().optional() },
    run: async ({ group_id, include_concluded }) => {
      if (group_id !== undefined) {
        const [group, members] = await Promise.all([
          ctx.client.get<Group>(`/groups/${group_id}`),
          ctx.client.getPaginated<User>(`/groups/${group_id}/users`, {}, 3),
        ]);
        return [
          `# ${group.name} (group_id=${group.id}) · ${group.context_name ?? ""}`,
          group.description ? oneLine(group.description, 300) : "",
          `${members.length} member(s): ${members.map((m) => m.name).join(", ")}`,
        ].filter(Boolean).join("\n");
      }
      const groups = (await ctx.client.getPaginated<Group>("/users/self/groups")).filter((g) => include_concluded || !g.concluded);
      if (groups.length === 0) return include_concluded ? "You're not in any groups." : "No active groups (include_concluded=true to see past ones).";
      return groups.map((g) => `- group_id=${g.id} ${g.name} · ${oneLine(g.context_name ?? "", 60)} · ${g.members_count} members${g.concluded ? " · concluded" : ""}`).join("\n");
    },
  });

  reg.add({
    name: "list_people",
    description: "People in a course: instructors and TAs (with email) by default, or students/all. Use to find who to contact.",
    input: {
      course_id: courseArg,
      role: z.enum(["staff", "teacher", "ta", "student", "all"]).optional().describe("default staff"),
      search: z.string().min(2).optional().describe("Name filter"),
    },
    run: async ({ course_id, role, search }) => {
      const courseId = await ctx.resolveCourseId(course_id);
      const kind = role ?? "staff";
      const users = await ctx.client.getPaginated<User>(
        `/courses/${courseId}/users`,
        { enrollment_type: ROLE_TYPES[kind]?.length ? ROLE_TYPES[kind] : undefined, include: ["email", "enrollments"], search_term: search },
        3,
      );
      if (users.length === 0) return "No matching people.";
      const lines = users.map((u) => {
        const roles = [...new Set((u.enrollments ?? []).map((e) => e.type.replace("Enrollment", "").toLowerCase()))].join("/");
        const staff = /teacher|ta/.test(roles);
        return `- ${u.name}${u.pronouns ? ` (${u.pronouns})` : ""} · ${roles || kind} · user_id=${u.id}${staff && u.email ? ` · ${u.email}` : ""}`;
      });
      return `${users.length} ${kind === "all" ? "people" : kind} in ${await ctx.courseLabel(courseId)}:\n${lines.join("\n")}`;
    },
  });

  reg.add({
    name: "get_recent_activity",
    description: "Your Canvas dashboard feed across active courses: new grades and feedback, announcements, discussion replies, messages. Good for 'what changed since I last checked'.",
    input: {
      limit: z.number().int().min(1).max(50).optional().describe("default 20"),
      only_unread: z.boolean().optional(),
    },
    run: async ({ limit, only_unread }) => {
      const tz = ctx.timeZone;
      const [items, summary] = await Promise.all([
        ctx.client.get<ActivityItem[]>("/users/self/activity_stream", { only_active_courses: true, per_page: only_unread ? 100 : limit ?? 20 }),
        ctx.client.get<Array<{ type: string; count: number; unread_count: number }>>("/users/self/activity_stream/summary", { only_active_courses: true }).catch(() => []),
      ]);
      const filtered = (only_unread ? items.filter((i) => i.read_state === false) : items).slice(0, limit ?? 20);
      const summaryLine = summary.length ? `Unread: ${summary.filter((s) => s.unread_count).map((s) => `${s.unread_count} ${s.type}`).join(", ") || "none"}` : "";
      const lines = await Promise.all(
        filtered.map(async (i) => {
          const where = i.course_id ? await ctx.courseLabel(i.course_id) : i.group_id ? `group ${i.group_id}` : "";
          const unread = i.read_state === false ? " · NEW" : "";
          let detail = "";
          if (i.type === "Submission") {
            const comment = i.submission_comments?.at(-1);
            detail = ` · ${i.score !== null && i.score !== undefined ? `score ${num(i.score)}/${num(i.assignment?.points_possible)}` : i.grade ?? "updated"}${comment ? ` · comment from ${comment.author_name ?? "?"}: ${oneLine(comment.comment, 120)}` : ""}`;
          } else if (i.message) {
            detail = `\n  ${oneLine(mdPreview(i.message, 160), 160)}`;
          }
          const title = i.title ?? i.assignment?.name ?? i.type;
          return `- ${fmtDate(i.updated_at ?? i.created_at, tz)} · ${i.type} · ${where} · ${oneLine(title, 90)}${unread}${detail}`;
        }),
      );
      return [summaryLine, lines.join("\n") || "No recent activity."].filter(Boolean).join("\n");
    },
  });
}
