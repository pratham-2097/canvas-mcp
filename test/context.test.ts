import { describe, expect, it } from "vitest";
import type { CanvasCourse } from "../src/canvas/types.js";
import { matchCourse, shortCourseName } from "../src/mcp/context.js";
import { fmtDate, mapLimit, num } from "../src/mcp/format.js";
import { InMemoryIndexStore } from "../src/index-store/memory-store.js";

const course = (id: number, name: string, code: string): CanvasCourse => ({ id, name, course_code: code, workflow_state: "available" });

const courses = [
  course(1, "(26FS-Full) INTRO TO CLOUD COMPUTING (001)", "2268-1_20CS5165001"),
  course(2, "(26FS-Full) COMPUTER NETWORKS (001)", "2268-1_20CS4065001"),
  course(3, "(26FS-Full) CS SENIOR DSGN I (001)", "2268-1_20CS5001001"),
];

describe("matchCourse", () => {
  it("matches by name fragment, case-insensitively", () => {
    expect(matchCourse("cloud", courses)).toBe(1);
    expect(matchCourse("Computer Networks", courses)).toBe(2);
  });

  it("matches by code fragment, ignoring separators", () => {
    expect(matchCourse("CS5165", courses)).toBe(1);
    expect(matchCourse("20CS4065", courses)).toBe(2);
  });

  it("matches multi-word queries by tokens", () => {
    expect(matchCourse("senior design", courses)).toBe(3);
  });

  it("errors with candidates when ambiguous, and when nothing matches", () => {
    expect(() => matchCourse("26FS", courses)).toThrow(/several courses/);
    expect(() => matchCourse("biology", courses)).toThrow(/No active course/);
  });
});

describe("formatting", () => {
  it("shortens Canvas course names", () => {
    expect(shortCourseName(courses[0]!)).toBe("INTRO TO CLOUD COMPUTING");
  });

  it("formats dates in the given time zone, compactly", () => {
    expect(fmtDate("2026-11-05T04:59:00Z", "America/New_York")).toMatch(/^Wed Nov 4( 2026)? 11:59pm$/);
    expect(fmtDate("2026-07-01T16:00:00Z", "America/New_York")).toMatch(/^Wed Jul 1( 2026)? 12pm$/);
    expect(fmtDate(null, "UTC")).toBe("no date");
  });

  it("formats numbers without trailing zeros", () => {
    expect(num(18)).toBe("18");
    expect(num(18.5)).toBe("18.5");
    expect(num(87.534)).toBe("87.53");
    expect(num(null)).toBe("-");
  });

  it("mapLimit preserves order and bounds concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20]);
    expect(peak).toBe(2);
  });
});

describe("InMemoryIndexStore", () => {
  it("evicts the least recently used course past its bound", async () => {
    const store = new InMemoryIndexStore(2);
    const idx = (id: number) => ({ course_id: id, documents: [], indexed_at: 0 });
    await store.set(1, idx(1));
    await store.set(2, idx(2));
    await store.get(1);
    await store.set(3, idx(3));
    expect(await store.get(2)).toBeUndefined();
    expect(await store.get(1)).toBeDefined();
    expect(await store.get(3)).toBeDefined();
  });
});
