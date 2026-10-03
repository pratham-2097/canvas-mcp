export type DocumentType =
  | "assignment"
  | "page"
  | "file"
  | "announcement"
  | "discussion"
  | "module_item"
  | "syllabus"
  | "external";

export interface IndexedDocument {
  id: string;
  course_id: number;
  type: DocumentType;
  title: string;
  html_url: string;
  module?: string;
  text: string;
  updated_at: string;
}

export interface CourseIndex {
  course_id: number;
  documents: IndexedDocument[];
  indexed_at: number;
}

/** Storage interface so the in-memory implementation can be swapped for a KV-backed one later without touching callers. */
export interface IndexStore {
  get(courseId: number): Promise<CourseIndex | undefined>;
  set(courseId: number, index: CourseIndex): Promise<void>;
  delete(courseId: number): Promise<void>;
}
