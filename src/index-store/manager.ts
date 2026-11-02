import type { CanvasClient } from "../canvas/client.js";
import { crawlCourse } from "./crawler.js";
import { BM25Index, chunkDocuments } from "./search.js";
import type { CourseIndex, IndexStore } from "./types.js";

const TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Time allowed for file extraction in one crawl. Keeps a first search of a
 * file-heavy course well inside an MCP client's request timeout; the rest
 * is indexed by later searches.
 */
const FILE_BUDGET_MS = 20_000;

export class CourseIndexManager {
  constructor(
    private readonly client: CanvasClient,
    private readonly store: IndexStore,
    private readonly fileBudgetMs = FILE_BUDGET_MS,
  ) {}

  async getIndex(courseId: number, forceRefresh = false): Promise<CourseIndex> {
    const cached = forceRefresh ? undefined : await this.store.get(courseId);
    const complete = cached && !cached.pending_files;
    if (complete && Date.now() - cached.indexed_at < TTL_MS) return cached;

    // An incomplete index is continued, reusing the file text it already has.
    const fresh = await crawlCourse(this.client, courseId, {
      previous: complete ? undefined : cached,
      fileBudgetMs: this.fileBudgetMs,
    });
    await this.store.set(courseId, fresh);
    return fresh;
  }

  async getSearchIndex(courseId: number, forceRefresh = false): Promise<{ index: BM25Index; pendingFiles: number }> {
    const courseIndex = await this.getIndex(courseId, forceRefresh);
    return { index: new BM25Index(chunkDocuments(courseIndex.documents)), pendingFiles: courseIndex.pending_files ?? 0 };
  }
}
