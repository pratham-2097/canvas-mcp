import { readFileSync, existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCanvasClientFromEnv } from "./canvas/client.js";
import { createCanvasMcpServer } from "./mcp/server.js";

/** Loads KEY=VALUE pairs from .dev.vars into process.env, without overwriting anything already set. */
function loadDevVars(path = ".dev.vars"): void {
  if (!existsSync(path)) return;
  const contents = readFileSync(path, "utf-8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main() {
  loadDevVars();
  const client = createCanvasClientFromEnv(process.env);
  const server = createCanvasMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("canvas-mcp stdio server failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
