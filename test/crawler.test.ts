import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import { continueCrawl, crawlCourse } from "../src/index-store/crawler.js";
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
    expect(index.pending_file_ids).toEqual([]);
  });

  it("caps files per crawl and continues without re-fetching listings", async () => {
    installFakeCanvas(routes());
    const first = await crawlCourse(client(), 5, { maxFiles: 1 });
    expect(first.pending_file_ids).toEqual([2, 3]);
    expect(first.documents.filter((d) => d.type === "file")).toHaveLength(1);

    const requests = installFakeCanvas(routes());
    const second = await continueCrawl(client(), first, { maxFiles: 5 });
    expect(second.pending_file_ids).toEqual([]);
    expect(second.documents.filter((d) => d.type === "file").map((d) => d.id)).toEqual(["file-1", "file-2", "file-3"]);
    expect(requests.every((r) => /\/(files|download)\//.test(r.url.pathname))).toBe(true);
  });

  it("leaves files pending once the time budget is spent", async () => {
    installFakeCanvas(routes());
    const index = await crawlCourse(client(), 5, { fileBudgetMs: -1 });
    expect(index.pending_file_ids).toEqual([1, 2, 3]);
  });

  it("indexes module file names with their ids even when contents are not extracted", async () => {
    installFakeCanvas(routes());
    const index = await crawlCourse(client(), 5, { maxFiles: 0 });
    expect(index.pending_file_ids).toEqual([1, 2, 3]);
    expect(index.documents.find((d) => d.id === "module_item-2")?.text).toBe("File: f2 (file_id=2)");
  });
});
