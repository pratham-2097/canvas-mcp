import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasApiError, CanvasClient } from "../src/canvas/client.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("CanvasClient pagination", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows the Link header across multiple pages", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1 }, { id: 2 }], {
          headers: {
            "Content-Type": "application/json",
            Link: '<https://canvas.example/api/v1/courses?page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ id: 3 }], {
          headers: { "Content-Type": "application/json", Link: "" },
        }),
      );

    const client = new CanvasClient({ baseUrl: "https://canvas.example/api/v1", token: "t" });
    const results = await client.getPaginated<{ id: number }>("/courses");

    expect(results).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops when there is no next link", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 1 }]));

    const client = new CanvasClient({ baseUrl: "https://canvas.example/api/v1", token: "t" });
    const results = await client.getPaginated<{ id: number }>("/courses");

    expect(results).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("always requests per_page=100", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const client = new CanvasClient({ baseUrl: "https://canvas.example/api/v1", token: "t" });
    await client.getPaginated("/courses");

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.get("per_page")).toBe("100");
  });

  it("serializes array params with [] suffix", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const client = new CanvasClient({ baseUrl: "https://canvas.example/api/v1", token: "t" });
    await client.getPaginated("/courses", { include: ["term", "syllabus_body"] });

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.searchParams.getAll("include[]")).toEqual(["term", "syllabus_body"]);
  });

  it("stops following pages at maxPages even if a next link remains", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse([{ id: 1 }], {
          headers: {
            "Content-Type": "application/json",
            Link: '<https://canvas.example/api/v1/courses?page=99>; rel="next"',
          },
        }),
      ),
    );

    const client = new CanvasClient({ baseUrl: "https://canvas.example/api/v1", token: "t" });
    const results = await client.getPaginated("/courses", undefined, 3);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
  });
});

describe("CanvasClient error handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries on 429 and succeeds once the server recovers", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }));

    const client = new CanvasClient({ baseUrl: "https://canvas.example/api/v1", token: "t" });
    const result = await client.get<{ id: number }>("/users/self");

    expect(result).toEqual({ id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws CanvasApiError with status 403 for a plain permission failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));

    const client = new CanvasClient({ baseUrl: "https://canvas.example/api/v1", token: "t" });
    await expect(client.get("/courses/1/files")).rejects.toMatchObject({ status: 403 });
  });

  it("gives up after repeated 429s and throws", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }));

    const client = new CanvasClient({ baseUrl: "https://canvas.example/api/v1", token: "t" });
    await expect(client.get("/courses")).rejects.toBeInstanceOf(CanvasApiError);
  });

  it("sends the bearer token and a User-Agent header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new CanvasClient({ baseUrl: "https://canvas.example/api/v1", token: "secret-token" });
    await client.get("/users/self");

    const headers = fetchMock.mock.calls[0]![1].headers;
    expect(headers.Authorization).toBe("Bearer secret-token");
    expect(headers["User-Agent"]).toBeTruthy();
  });
});
