import { z } from "zod";
import { CanvasApiError } from "../../canvas/client.js";
import { getCourseWithSyllabus, getFrontPage, getPage, listModules, listPages } from "../../canvas/endpoints.js";
import { htmlToMarkdown } from "../../canvas/html.js";
import type { CanvasModuleItem } from "../../canvas/types.js";
import type { ServerContext } from "../context.js";
import { fmtDate, num, oneLine } from "../format.js";
import type { ToolRegistry } from "../registry.js";
import { courseArg } from "../shared.js";

/** The id a follow-up tool needs for this item, so the model never has to parse a URL. */
function itemRef(i: CanvasModuleItem): string {
  switch (i.type) {
    case "Assignment":
      return `assignment_id=${i.content_id}`;
    case "Quiz":
      return `quiz_id=${i.content_id}`;
    case "Discussion":
      return `topic_id=${i.content_id}`;
    case "File":
      return `file_id=${i.content_id}`;
    case "Page":
      return `page_url=${i.page_url}`;
    case "ExternalUrl":
    case "ExternalTool":
      return i.external_url ?? "";
    default:
      return "";
  }
}

export function registerContentTools(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "list_modules",
    description: "A course's modules in order with each item's type, id, due date and your completion status. Use to see course structure or what's left in a module.",
    input: { course_id: courseArg, module_name: z.string().optional().describe("Only modules whose name contains this") },
    run: async ({ course_id, module_name }) => {
      const courseId = await ctx.resolveCourseId(course_id);
      let modules = await listModules(ctx.client, courseId);
      if (module_name) modules = modules.filter((m) => m.name.toLowerCase().includes(module_name.toLowerCase()));
      if (modules.length === 0) return module_name ? `No module name contains "${module_name}".` : "No modules found.";
      const blocks = modules.map((m) => {
        const state = m.state && m.state !== "unlocked" ? ` [${m.state}${m.state === "locked" && m.unlock_at ? ` until ${fmtDate(m.unlock_at, ctx.timeZone)}` : ""}]` : "";
        const items = (m.items ?? []).map((i) => {
          if (i.type === "SubHeader") return `  ${"  ".repeat(i.indent ?? 0)}### ${i.title}`;
          const done = i.completion_requirement ? (i.completion_requirement.completed ? " ✓" : " ☐") : "";
          const d = i.content_details;
          const due = d?.due_at ? ` · due ${fmtDate(d.due_at, ctx.timeZone)}` : "";
          const pts = d?.points_possible ? ` · ${num(d.points_possible)}pts` : "";
          const ref = itemRef(i);
          return `  ${"  ".repeat(i.indent ?? 0)}-${done} [${i.type}] ${oneLine(i.title, 100)}${due}${pts}${ref ? ` (${ref})` : ""}`;
        });
        return `## ${m.name}${state}\n${items.join("\n") || "  (empty)"}`;
      });
      return `course_id=${courseId}\n${blocks.join("\n")}`;
    },
  });

  reg.add({
    name: "get_page",
    description: "Read a course page as markdown. page_url: a page slug, 'front_page', or 'syllabus'. Omit page_url to list all pages.",
    input: { course_id: courseArg, page_url: z.string().optional() },
    run: async ({ course_id, page_url }) => {
      const courseId = await ctx.resolveCourseId(course_id);
      if (!page_url) {
        const pages = await listPages(ctx.client, courseId).catch((err) => {
          // Canvas 404s the page list when a course disables its Pages tab.
          if (err instanceof CanvasApiError && (err.status === 404 || err.status === 403)) return [];
          throw err;
        });
        if (pages.length === 0) return "No pages listed (the Pages tab may be disabled). Try list_modules, or page_url='front_page' or 'syllabus'.";
        const lines = pages.map((p) => `- ${oneLine(p.title, 100)} (page_url=${p.url}) · updated ${fmtDate(p.updated_at, ctx.timeZone)}`);
        return `${pages.length} page(s):\n${lines.join("\n")}`;
      }
      if (page_url === "syllabus") {
        const course = await getCourseWithSyllabus(ctx.client, courseId);
        if (!course.syllabus_body) return "This course has no syllabus body set. Try search_course for 'syllabus' (it may be a file or page).";
        return `# ${course.name} — Syllabus\n\n${htmlToMarkdown(course.syllabus_body)}`;
      }
      const page = page_url === "front_page" ? await getFrontPage(ctx.client, courseId) : await getPage(ctx.client, courseId, page_url);
      return `# ${page.title}\n${page.html_url}\n\n${htmlToMarkdown(page.body ?? "")}`;
    },
  });
}
