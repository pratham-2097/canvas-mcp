import type { CanvasClient } from "../canvas/client.js";
import { crawlCourse } from "./crawler.js";
import { BM25Index, chunkDocuments } from "./search.js";
import type { CourseIndex, IndexStore } from "./types.js";

const TTL_MS = 6 * 60 * 60 * 1000;

export class CourseIndexManager {
  constructor(
    private readonly client: CanvasClient,
    private readonly store: IndexStore,
  ) {}

  async getIndex(courseId: number, forceRefresh = false): Promise<CourseIndex> {
    if (!forceRefresh) {
      const cached = await this.store.get(courseId);
      if (cached && Date.now() - cached.indexed_at < TTL_MS) {
        return cached;
      }
    }

    const fresh = await crawlCourse(this.client, courseId);
    await this.store.set(courseId, fresh);
    return fresh;
  }

  async getSearchIndex(courseId: number, forceRefresh = false): Promise<BM25Index> {
    const index = await this.getIndex(courseId, forceRefresh);
    return new BM25Index(chunkDocuments(index.documents));
  }
}
