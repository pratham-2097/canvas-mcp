export interface CanvasTerm {
  id: number;
  name: string;
}

export interface CanvasCourse {
  id: number;
  name: string;
  course_code: string;
  workflow_state: string;
  term?: CanvasTerm;
}

export interface CanvasSubmission {
  id: number;
  workflow_state: string;
  submitted_at: string | null;
  score: number | null;
  missing: boolean;
  late: boolean;
}

export interface CanvasAssignment {
  id: number;
  course_id: number;
  name: string;
  description: string | null;
  due_at: string | null;
  points_possible: number | null;
  html_url: string;
  submission_types: string[];
  submission?: CanvasSubmission;
  rubric?: unknown[];
  rubric_settings?: unknown;
}

export interface CanvasMissingSubmission extends CanvasAssignment {
  course?: CanvasCourse;
}

export interface CanvasModuleItem {
  id: number;
  module_id: number;
  title: string;
  type: string;
  html_url: string;
  content_id?: number;
  url?: string;
  position: number;
}

export interface CanvasModule {
  id: number;
  name: string;
  position: number;
  items?: CanvasModuleItem[];
}

export interface CanvasPage {
  page_id: number;
  url: string;
  title: string;
  body?: string;
  html_url: string;
  updated_at: string;
}

export interface CanvasFile {
  id: number;
  display_name: string;
  filename: string;
  "content-type": string;
  url: string;
  size: number;
  updated_at: string;
}

export interface CanvasAnnouncement {
  id: number;
  title: string;
  message: string;
  html_url: string;
  posted_at: string;
}

export interface CanvasDiscussionTopic {
  id: number;
  title: string;
  message: string;
  html_url: string;
  posted_at: string | null;
}

export interface CanvasCourseWithSyllabus extends CanvasCourse {
  syllabus_body?: string;
}
