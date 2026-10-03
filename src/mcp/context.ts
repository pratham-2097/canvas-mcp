import type { CanvasClient } from "../canvas/client.js";
import { CourseIndexManager } from "../index-store/manager.js";
import { InMemoryIndexStore } from "../index-store/memory-store.js";

export interface ServerContext {
  client: CanvasClient;
  indexManager: CourseIndexManager;
}

export function createServerContext(client: CanvasClient): ServerContext {
  const store = new InMemoryIndexStore();
  const indexManager = new CourseIndexManager(client, store);
  return { client, indexManager };
}
