import type { CanvasClient } from "../canvas/client.js";
import { continueCrawl, crawlCourse, type CrawlOptions } from "./crawler.js";
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
  private readonly options: CrawlOptions;

  constructor(
    private readonly client: CanvasClient,
    private readonly store: IndexStore,
    options: CrawlOptions = {},
  ) {
    this.options = { fileBudgetMs: FILE_BUDGET_MS, ...options };
  }

  async getIndex(courseId: number, forceRefresh = false): Promise<CourseIndex> {
    const cached = forceRefresh ? undefined : await this.store.get(courseId);
    let next: CourseIndex;
    if (cached && Date.now() - cached.indexed_at < TTL_MS) {
      // maxFiles 0 means file contents are never extracted on this host.
      if (!cached.pending_file_ids?.length || this.options.maxFiles === 0) return cached;
      next = await continueCrawl(this.client, cached, this.options);
    } else {
      next = await crawlCourse(this.client, courseId, this.options);
    }
    await this.store.set(courseId, next);
    return next;
  }

  /** False when this host never extracts file contents into the index. */
  get extractsFiles(): boolean {
    return this.options.maxFiles !== 0;
  }

  async getSearchIndex(courseId: number, forceRefresh = false): Promise<{ index: BM25Index; pendingFiles: number }> {
    return this.toSearch(await this.getIndex(courseId, forceRefresh));
  }

  /** The index only if one is already built; never crawls. */
  async getCachedSearchIndex(courseId: number): Promise<{ index: BM25Index; pendingFiles: number } | null> {
    const cached = await this.store.get(courseId);
    return cached ? this.toSearch(cached) : null;
  }

  private toSearch(courseIndex: CourseIndex) {
    return { index: new BM25Index(chunkDocuments(courseIndex.documents)), pendingFiles: courseIndex.pending_file_ids?.length ?? 0 };
  }
}
