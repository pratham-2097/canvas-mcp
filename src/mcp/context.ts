import type { CanvasClient } from "../canvas/client.js";
import { listActiveCourses } from "../canvas/endpoints.js";
import type { CanvasCourse } from "../canvas/types.js";
import { CourseIndexManager } from "../index-store/manager.js";
import { InMemoryIndexStore } from "../index-store/memory-store.js";
import type { IndexStore } from "../index-store/types.js";

const COURSE_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_TIME_ZONE = "America/New_York";

/**
 * State that outlives a single MCP request. The Worker builds a fresh server
 * per request (stateless transport), so caches must live here, at module
 * scope, or they never get a second hit.
 */
export interface SharedState {
  store: IndexStore;
  courses?: { at: number; list: CanvasCourse[] };
}

export function createSharedState(): SharedState {
  return { store: new InMemoryIndexStore() };
}

export interface ServerContext {
  client: CanvasClient;
  indexManager: CourseIndexManager;
  timeZone: string;
  listCourses(): Promise<CanvasCourse[]>;
  /** Resolves a course id, code, or name fragment to a numeric course id. */
  resolveCourseId(input: number | string): Promise<number>;
  courseLabel(courseId: number | null | undefined): Promise<string>;
}

export interface ContextOptions {
  shared?: SharedState;
  timeZone?: string;
  /** Files extracted per search call; unlimited unless set (the Worker sets it). */
  maxFilesPerCrawl?: number;
}

export function createServerContext(client: CanvasClient, options: ContextOptions = {}): ServerContext {
  const shared = options.shared ?? createSharedState();
  const indexManager = new CourseIndexManager(client, shared.store, { maxFiles: options.maxFilesPerCrawl });

  async function listCourses(): Promise<CanvasCourse[]> {
    if (shared.courses && Date.now() - shared.courses.at < COURSE_CACHE_TTL_MS) return shared.courses.list;
    const list = await listActiveCourses(client);
    shared.courses = { at: Date.now(), list };
    return list;
  }

  return {
    client,
    indexManager,
    timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
    listCourses,
    async resolveCourseId(input) {
      if (typeof input === "number") return input;
      const trimmed = input.trim();
      if (/^\d+$/.test(trimmed)) return Number(trimmed);
      return matchCourse(trimmed, await listCourses());
    },
    async courseLabel(courseId) {
      if (!courseId) return "unknown course";
      const course = (await listCourses().catch(() => [])).find((c) => c.id === courseId);
      return course ? shortCourseName(course) : `course ${courseId}`;
    },
  };
}

/** "(26FS-Full) INTRO TO CLOUD COMPUTING (001)" -> "INTRO TO CLOUD COMPUTING" */
export function shortCourseName(course: Pick<CanvasCourse, "name" | "course_code">): string {
  const cleaned = course.name.replace(/^\([^)]*\)\s*/, "").replace(/\s*\(\d+\)\s*$/, "").trim();
  return cleaned || course.course_code;
}

/** Canvas names abbreviate words ("DSGN" for design): same first letter, letters in order. */
function isAbbreviation(short: string, word: string): boolean {
  if (short.length >= word.length || short[0] !== word[0]) return false;
  let i = 0;
  for (const ch of word) if (ch === short[i]) i++;
  return i === short.length;
}

export function matchCourse(query: string, courses: CanvasCourse[]): number {
  const q = query.toLowerCase().replace(/\s+/g, " ");
  const compact = q.replace(/[\s_-]/g, "");
  const scored = courses
    .map((c) => {
      const name = c.name.toLowerCase();
      const code = c.course_code.toLowerCase();
      const codeCompact = code.replace(/[\s_-]/g, "");
      let score = 0;
      if (code === q || name === q) score = 100;
      else if (codeCompact.includes(compact)) score = 80;
      else if (name.includes(q)) score = 70;
      else {
        const tokens = q.split(" ").filter(Boolean);
        const nameTokens = name.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
        const hits = tokens.filter(
          (t) => name.includes(t) || code.includes(t) || nameTokens.some((n) => isAbbreviation(n, t)),
        ).length;
        score = tokens.length ? (hits / tokens.length) * 60 : 0;
      }
      return { c, score };
    })
    .filter((s) => s.score >= 50)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) {
    throw new Error(`No active course matches "${query}". Call list_courses to see course ids.`);
  }
  const tied = scored.filter((s) => s.score === best.score);
  if (tied.length > 1) {
    const options = tied.slice(0, 6).map((s) => `${s.c.id} ${shortCourseName(s.c)}`).join("; ");
    throw new Error(`"${query}" matches several courses: ${options}. Pass the course id.`);
  }
  return best.c.id;
}
