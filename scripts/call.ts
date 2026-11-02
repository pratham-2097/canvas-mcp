/** Calls one tool in-process against real Canvas: npx tsx scripts/call.ts <tool> '<json args>' */
import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCanvasClientFromEnv } from "../src/canvas/client.js";
import { createCanvasMcpServer } from "../src/mcp/server.js";

if (existsSync(".dev.vars")) {
  for (const line of readFileSync(".dev.vars", "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
  }
}
const server = createCanvasMcpServer(createCanvasClientFromEnv(process.env), { timeZone: process.env.CANVAS_TIME_ZONE });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(b);
const client = new Client({ name: "call", version: "0" });
await client.connect(a);
const result = await client.callTool({ name: process.argv[2] ?? "list_courses", arguments: JSON.parse(process.argv[3] ?? "{}") });
console.log((result.content as Array<{ text: string }>).map((c) => c.text).join("\n"));
await client.close();
