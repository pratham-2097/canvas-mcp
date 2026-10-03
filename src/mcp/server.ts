import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CanvasClient } from "../canvas/client.js";
import { createServerContext } from "./context.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerContentTools } from "./tools/content.js";
import { registerCourseTools } from "./tools/courses.js";
import { registerGatherContextTool } from "./tools/gather-context.js";
import { registerMissingWorkTool } from "./tools/missing-work.js";
import { registerSearchTool } from "./tools/search.js";

export function createCanvasMcpServer(client: CanvasClient): McpServer {
  const server = new McpServer({ name: "canvas-mcp", version: "0.1.0" });
  const ctx = createServerContext(client);

  registerCourseTools(server, ctx);
  registerMissingWorkTool(server, ctx);
  registerAssignmentTools(server, ctx);
  registerContentTools(server, ctx);
  registerSearchTool(server, ctx);
  registerGatherContextTool(server, ctx);

  return server;
}
