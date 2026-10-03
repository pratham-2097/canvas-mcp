import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CanvasClient } from "./canvas/client.js";
import { createCanvasMcpServer } from "./mcp/server.js";

export interface Env {
  CANVAS_TOKEN: string;
  CANVAS_BASE_URL?: string;
  ACCESS_PASSPHRASE: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function unauthorized(): Response {
  return withCors(new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } }));
}

/**
 * Accepts the passphrase whether it arrives as "Bearer <token>" (any
 * casing/spacing) or as a bare token with no scheme prefix, since different
 * MCP clients' custom-header UIs disagree on which shape they send.
 */
function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization");
  if (!header) return false;
  const bearerMatch = header.match(/^Bearer\s+(.+)$/i);
  const token = (bearerMatch?.[1] ?? header).trim();
  return token.length > 0 && token === env.ACCESS_PASSPHRASE;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/mcp") {
      return withCors(new Response("Not found", { status: 404 }));
    }

    // Browser preflight carries no Authorization header by design; it must
    // be answered before the auth check or browser-based clients (e.g. a
    // connector added in a chat web app) can never send the real request.
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (!isAuthorized(request, env)) {
      const header = request.headers.get("Authorization");
      console.log(
        "auth rejected:",
        JSON.stringify({
          hasHeader: header !== null,
          headerLength: header?.length ?? 0,
          headerPrefix: header?.slice(0, 10) ?? null,
          expectedLength: env.ACCESS_PASSPHRASE?.length ?? 0,
        }),
      );
      return unauthorized();
    }

    const client = new CanvasClient({
      baseUrl: env.CANVAS_BASE_URL ?? "https://uc.instructure.com/api/v1",
      token: env.CANVAS_TOKEN,
    });
    const server = createCanvasMcpServer(client);

    // Stateless mode: a fresh transport per request, no session tracking.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    const response = await transport.handleRequest(request);
    return withCors(response);
  },
};
