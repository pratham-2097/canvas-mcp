import { describe, expect, it } from "vitest";
import { BM25Index, chunkDocuments, chunkText } from "../src/index-store/search.js";
import type { IndexedDocument } from "../src/index-store/types.js";

function makeDoc(overrides: Partial<IndexedDocument>): IndexedDocument {
  return {
    id: "doc-1",
    course_id: 1,
    type: "assignment",
    title: "Untitled",
    html_url: "https://example.com",
    text: "",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("chunkText", () => {
  it("returns the whole text as one chunk when under the size limit", () => {
    const chunks = chunkText("short text", 1500, 200);
    expect(chunks).toEqual(["short text"]);
  });

  it("returns no chunks for empty text", () => {
    expect(chunkText("", 1500, 200)).toEqual([]);
  });

  it("splits long text into overlapping chunks", () => {
    const text = "a".repeat(4000);
    const chunks = chunkText(text, 1500, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // consecutive chunks overlap by `overlap` chars
    expect(chunks[0]!.slice(-200)).toBe(chunks[1]!.slice(0, 200));
  });

  it("covers the entire input with no gaps", () => {
    const text = Array.from({ length: 4000 }, (_, i) => String(i % 10)).join("");
    const chunks = chunkText(text, 1500, 200);
    const rebuilt = chunks.reduce((acc, chunk, i) => (i === 0 ? chunk : acc + chunk.slice(200)), "");
    expect(rebuilt).toBe(text);
  });
});

describe("chunkDocuments", () => {
  it("skips documents with empty text", () => {
    const docs = [makeDoc({ text: "" }), makeDoc({ id: "doc-2", text: "hello world" })];
    const chunks = chunkDocuments(docs);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.doc.id).toBe("doc-2");
  });
});

describe("BM25Index", () => {
  it("ranks a chunk containing all query terms above one containing none", () => {
    const docs = [
      makeDoc({ id: "a", title: "A", text: "rasterization and triangle drawing in computer graphics" }),
      makeDoc({ id: "b", title: "B", text: "personal finance budgeting for college students" }),
    ];
    const index = new BM25Index(chunkDocuments(docs));
    const results = index.search("triangle rasterization");
    expect(results[0]!.doc.id).toBe("a");
    expect(results.find((r) => r.doc.id === "b")).toBeUndefined();
  });

  it("returns no results for a query with no matching terms", () => {
    const docs = [makeDoc({ text: "completely unrelated content about gardening" })];
    const index = new BM25Index(chunkDocuments(docs));
    expect(index.search("quantum mechanics")).toEqual([]);
  });

  it("respects the types filter", () => {
    const docs = [
      makeDoc({ id: "a", type: "assignment", text: "project rasterization details" }),
      makeDoc({ id: "b", type: "file", text: "project rasterization slides" }),
    ];
    const index = new BM25Index(chunkDocuments(docs));
    const results = index.search("rasterization", { types: ["file"] });
    expect(results).toHaveLength(1);
    expect(results[0]!.doc.type).toBe("file");
  });

  it("respects the limit option", () => {
    const docs = Array.from({ length: 10 }, (_, i) => makeDoc({ id: `doc-${i}`, text: "rasterization triangle" }));
    const index = new BM25Index(chunkDocuments(docs));
    expect(index.search("rasterization", { limit: 3 })).toHaveLength(3);
  });

  it("scores a term appearing more frequently higher, all else equal", () => {
    const docs = [
      makeDoc({ id: "a", text: "triangle triangle triangle shape shape shape filler filler filler words words" }),
      makeDoc({ id: "b", text: "triangle appears once shape appears once filler filler filler words words words" }),
    ];
    const index = new BM25Index(chunkDocuments(docs));
    const results = index.search("triangle");
    const scoreA = results.find((r) => r.doc.id === "a")!.score;
    const scoreB = results.find((r) => r.doc.id === "b")!.score;
    expect(scoreA).toBeGreaterThan(scoreB);
  });
});
