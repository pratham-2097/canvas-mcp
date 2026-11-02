import type { CourseIndex, IndexStore } from "./types.js";

/**
 * In-memory store with a small LRU bound. On Workers it lives for the life
 * of an isolate (128MB), so it must not grow with every course ever searched.
 */
export class InMemoryIndexStore implements IndexStore {
  private readonly map = new Map<number, CourseIndex>();

  constructor(private readonly maxCourses = 8) {}

  async get(courseId: number): Promise<CourseIndex | undefined> {
    const index = this.map.get(courseId);
    if (index) {
      this.map.delete(courseId);
      this.map.set(courseId, index);
    }
    return index;
  }

  async set(courseId: number, index: CourseIndex): Promise<void> {
    this.map.delete(courseId);
    this.map.set(courseId, index);
    while (this.map.size > this.maxCourses) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  async delete(courseId: number): Promise<void> {
    this.map.delete(courseId);
  }
}
