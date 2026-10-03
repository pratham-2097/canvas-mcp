import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listActiveCourses } from "../../canvas/endpoints.js";
import type { ServerContext } from "../context.js";
import { textResult } from "../shared.js";

export function registerCourseTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "list_courses",
    {
      title: "List Courses",
      description:
        "List active Canvas courses for the current user, including term info. Use this to discover course_id values for other tools.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const courses = await listActiveCourses(ctx.client);
      const lines = courses.map(
        (c) => `- course_id=${c.id} | ${c.name} (${c.course_code}) | term=${c.term?.name ?? "n/a"}`,
      );
      return textResult(
        courses.length === 0
          ? "No active courses found."
          : `${courses.length} active course(s):\n${lines.join("\n")}`,
      );
    },
  );
}
