/**
 * Prints what the tool list costs a client's context window: every tool's
 * name, description and input schema exactly as tools/list sends them.
 * Tokens are estimated at ~4 chars/token.
 */
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CanvasClient } from "../src/canvas/client.js";
import { createCanvasMcpServer } from "../src/mcp/server.js";

export async function measureToolFootprint() {
  const server = createCanvasMcpServer(new CanvasClient({ baseUrl: "https://canvas.invalid/api/v1", token: "x" }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "footprint", version: "0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() ?? "";
  await client.close();
  const perTool: Array<{ name: string; chars: number; json: string }> = tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length, json: JSON.stringify(t) }));
  const totalChars = JSON.stringify(tools).length + instructions.length;
  return { count: tools.length, perTool, totalChars, approxTokens: Math.round(totalChars / 4), instructionsChars: instructions.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = await measureToolFootprint();
  const dump = process.argv[2];
  if (dump) {
    console.log(r.perTool.find((t) => t.name === dump)?.json ?? `no tool named ${dump}`);
    process.exit(0);
  }
  for (const t of r.perTool.sort((a, b) => b.chars - a.chars)) console.log(`${String(t.chars).padStart(6)}  ${t.name}`);
  console.log(`\n${r.count} tools, ${r.totalChars} chars (instructions ${r.instructionsChars}), ~${r.approxTokens} tokens`);
}
