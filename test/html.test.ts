import { describe, expect, it } from "vitest";
import { extractLinks, htmlToMarkdown } from "../src/canvas/html.js";

describe("extractLinks", () => {
  it("classifies a full-path file link with course id", () => {
    const [link] = extractLinks('<a href="/courses/5/files/99">doc</a>');
    expect(link).toMatchObject({ kind: "file", fileId: 99, courseId: 5 });
  });

  it("classifies a bare /files/:id link without a course id", () => {
    const [link] = extractLinks('<a href="/files/42/download">doc</a>');
    expect(link).toMatchObject({ kind: "file", fileId: 42 });
    expect(link!.courseId).toBeUndefined();
  });

  it("classifies a page link and decodes the url slug", () => {
    const [link] = extractLinks('<a href="/courses/5/pages/project-1">page</a>');
    expect(link).toMatchObject({ kind: "page", pageUrl: "project-1", courseId: 5 });
  });

  it("classifies anything else as external", () => {
    const [link] = extractLinks('<a href="https://kaltura.com/video/1">video</a>');
    expect(link).toMatchObject({ kind: "external", href: "https://kaltura.com/video/1" });
  });

  it("extracts img src as well as a href", () => {
    const links = extractLinks('<img src="/courses/5/files/7" alt="diagram">');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: "file", fileId: 7 });
  });

  it("returns an empty array for empty or null-ish html", () => {
    expect(extractLinks("")).toEqual([]);
  });

  it("handles multiple links in one document, in document order", () => {
    const html = '<p><a href="/courses/1/files/1">a</a> <a href="/courses/1/pages/b">b</a></p>';
    const links = extractLinks(html);
    expect(links.map((l) => l.kind)).toEqual(["file", "page"]);
  });
});

describe("htmlToMarkdown", () => {
  it("converts a link to markdown while preserving the href", () => {
    const md = htmlToMarkdown('<p>See <a href="/courses/1/files/1">this file</a>.</p>');
    expect(md).toContain("[this file](/courses/1/files/1)");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  it("converts headings and lists", () => {
    const md = htmlToMarkdown("<h2>Title</h2><ul><li>one</li><li>two</li></ul>");
    expect(md).toContain("Title");
    expect(md).toContain("one");
    expect(md).toContain("two");
  });
});
