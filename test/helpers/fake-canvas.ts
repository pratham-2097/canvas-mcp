import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi } from "vitest";
import { CanvasClient } from "../../src/canvas/client.js";
import { createCanvasMcpServer } from "../../src/mcp/server.js";

export const BASE = "https://canvas.test/api/v1";

type Handler = unknown | ((url: URL) => unknown);

export interface RecordedRequest {
  method: string;
  url: URL;
}

/**
 * Stubs global fetch with a router keyed by API path (no query string).
 * Unknown paths return 404, like Canvas for something hidden. Every
 * request is recorded so tests can assert the server stays read-only.
 */
export function installFakeCanvas(routes: Record<string, Handler>) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? "GET", url });
      if (url.pathname.startsWith("/download/")) return new Response(new TextEncoder().encode(`contents of ${url.pathname}`));
      const path = url.pathname.replace("/api/v1", "");
      if (!(path in routes)) return new Response(JSON.stringify({ errors: [{ message: "not found" }] }), { status: 404 });
      const handler = routes[path];
      const body = typeof handler === "function" ? (handler as (u: URL) => unknown)(url) : handler;
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return requests;
}

export async function connectClient() {
  const server = createCanvasMcpServer(new CanvasClient({ baseUrl: BASE, token: "test-token" }), { timeZone: "America/New_York" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
      return { text, isError: Boolean(result.isError) };
    },
  };
}
