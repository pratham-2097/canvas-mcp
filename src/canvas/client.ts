export interface CanvasClientConfig {
  baseUrl: string;
  token: string;
}

export class CanvasApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "CanvasApiError";
  }
}

function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match && match[1] && match[2]) links[match[2]] = match[1];
  }
  return links;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal GET-only Canvas API client. There is no verb other than `get` on
 * purpose: this server must never be able to mutate Canvas state.
 */
export class CanvasClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: CanvasClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
  }

  private buildUrl(path: string, params?: Record<string, unknown>): string {
    const url = path.startsWith("http") ? new URL(path) : new URL(this.baseUrl + path);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(`${key}[]`, String(v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /** Single GET request with 429 backoff. Retries up to 5 times. */
  private async getRaw(url: string, attempt = 0): Promise<Response> {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        // Canvas rejects requests with no User-Agent (fetch on Workers sends none by default).
        "User-Agent": "canvas-mcp/0.1 (personal read-only MCP server)",
      },
    });

    const remaining = res.headers.get("X-Rate-Limit-Remaining");
    if (res.status === 429 || (remaining !== null && Number(remaining) < 1 && res.status >= 400)) {
      if (attempt >= 5) {
        throw new CanvasApiError(`Rate limited after ${attempt} retries`, res.status, url);
      }
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfter = retryAfterHeader !== null && !Number.isNaN(Number(retryAfterHeader))
        ? Number(retryAfterHeader)
        : 2 ** attempt;
      await sleep(retryAfter * 1000);
      return this.getRaw(url, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CanvasApiError(`Canvas API ${res.status} for ${url}: ${body.slice(0, 500)}`, res.status, url);
    }

    return res;
  }

  /** GET a single resource (non-paginated endpoint). */
  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const url = this.buildUrl(path, params);
    const res = await this.getRaw(url);
    return res.json() as Promise<T>;
  }

  /**
   * Downloads raw bytes from a Canvas-hosted file URL (e.g. a file's
   * `.url` field), attaching the same bearer token used for API calls.
   */
  async getBytes(url: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: number }> {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "canvas-mcp/0.1 (personal read-only MCP server)",
      },
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  /**
   * GET a paginated list endpoint, following the `Link` header until
   * exhausted or `maxPages` is reached. Always sends per_page=100.
   */
  async getPaginated<T>(
    path: string,
    params?: Record<string, unknown>,
    maxPages = 20,
  ): Promise<T[]> {
    let url = this.buildUrl(path, { per_page: 100, ...params });
    const results: T[] = [];
    let page = 0;

    while (url && page < maxPages) {
      const res = await this.getRaw(url);
      const batch = (await res.json()) as T[];
      results.push(...batch);
      const links = parseLinkHeader(res.headers.get("Link"));
      url = links.next ?? "";
      page += 1;
    }

    return results;
  }
}

export function createCanvasClientFromEnv(env: {
  CANVAS_BASE_URL?: string;
  CANVAS_TOKEN?: string;
}): CanvasClient {
  const baseUrl = env.CANVAS_BASE_URL ?? "https://uc.instructure.com/api/v1";
  const token = env.CANVAS_TOKEN;
  if (!token) {
    throw new Error("CANVAS_TOKEN is not set. Copy .env.example to .dev.vars and fill it in.");
  }
  return new CanvasClient({ baseUrl, token });
}
