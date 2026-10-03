import type { CourseIndex, IndexStore } from "./types.js";

export class InMemoryIndexStore implements IndexStore {
  private readonly map = new Map<number, CourseIndex>();

  async get(courseId: number): Promise<CourseIndex | undefined> {
    return this.map.get(courseId);
  }

  async set(courseId: number, index: CourseIndex): Promise<void> {
    this.map.set(courseId, index);
  }

  async delete(courseId: number): Promise<void> {
    this.map.delete(courseId);
  }
}
