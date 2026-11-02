import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import { crawlCourse } from "../src/index-store/crawler.js";
import { BASE, installFakeCanvas } from "./helpers/fake-canvas.js";

const file = (id: number) => ({ id, filename: `f${id}.txt`, "content-type": "text/plain", url: `https://canvas.test/download/${id}`, size: 10, updated_at: "2026-01-01T00:00:00Z" });

function routes() {
  return {
    "/courses/5/modules": [{ id: 1, name: "M", position: 1, items: [1, 2, 3].map((id) => ({ id, module_id: 1, title: `f${id}`, type: "File", content_id: id, html_url: "x", position: id })) }],
    "/files/1": file(1),
    "/files/2": file(2),
    "/files/3": file(3),
  };
}

describe("crawlCourse", () => {
  afterEach(() => vi.unstubAllGlobals());
  const client = () => new CanvasClient({ baseUrl: BASE, token: "t" });

  it("extracts every discovered file when there is no budget", async () => {
    installFakeCanvas(routes());
    const index = await crawlCourse(client(), 5);
    expect(index.documents.filter((d) => d.type === "file").map((d) => d.text).sort()).toEqual([
      "contents of /download/1", "contents of /download/2", "contents of /download/3",
    ]);
    expect(index.pending_files).toBe(0);
  });

  it("leaves files pending past the budget and reuses extracted text on the next crawl", async () => {
    installFakeCanvas(routes());
    const first = await crawlCourse(client(), 5, { fileBudgetMs: -1 });
    expect(first.pending_files).toBe(3);

    const requests = installFakeCanvas(routes());
    const partial = { ...first, documents: [...first.documents, { id: "file-1", course_id: 5, type: "file" as const, title: "f1.txt", html_url: "x", text: "cached text", updated_at: "" }] };
    const second = await crawlCourse(client(), 5, { previous: partial });
    expect(second.pending_files).toBe(0);
    expect(second.documents.find((d) => d.id === "file-1")?.text).toBe("cached text");
    expect(requests.some((r) => r.url.pathname === "/api/v1/files/1")).toBe(false);
    expect(requests.some((r) => r.url.pathname === "/api/v1/files/2")).toBe(true);
  });
});
