import { z } from "zod";
import type { CanvasCourse } from "../../canvas/types.js";
import type { ServerContext } from "../context.js";
import { shortCourseName } from "../context.js";
import type { ToolRegistry } from "../registry.js";

export function registerCourseTools(reg: ToolRegistry, ctx: ServerContext): void {
  reg.add({
    name: "list_courses",
    description:
      "Your Canvas profile and courses (id, code, name, term, your role). Other tools also accept a course name or code directly, so this is only needed to browse.",
    input: { include_concluded: z.boolean().optional().describe("Also past courses") },
    run: async ({ include_concluded }) => {
      const [profile, courses] = await Promise.all([
        ctx.client.get<{ id: number; name: string; login_id?: string; primary_email?: string; time_zone?: string }>("/users/self/profile").catch(() => null),
        include_concluded
          ? ctx.client.getPaginated<CanvasCourse>("/courses", { include: ["term"], state: ["available", "completed"] })
          : ctx.listCourses(),
      ]);
      const me = profile ? `You: ${profile.name} (user_id=${profile.id}${profile.login_id ? `, ${profile.login_id}` : ""}${profile.time_zone ? `, ${profile.time_zone}` : ""})\n` : "";
      if (courses.length === 0) return `${me}No courses found.`;
      const lines = courses.map((c) => {
        const role = c.enrollments?.find((e) => e.type !== "student")?.type;
        return `- ${c.id} | ${shortCourseName(c)} | ${c.course_code} | ${c.term?.name ?? "no term"}${role ? ` | role: ${role}` : ""}`;
      });
      return `${me}${courses.length} course(s):\n${lines.join("\n")}`;
    },
  });
}
