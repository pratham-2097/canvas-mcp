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
  enrollments?: Array<{ type: string; role?: string }>;
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
  rubric?: CanvasRubricCriterion[];
  rubric_settings?: unknown;
  lock_at?: string | null;
  unlock_at?: string | null;
  allowed_attempts?: number;
  allowed_extensions?: string[];
  locked_for_user?: boolean;
  lock_explanation?: string;
  peer_reviews?: boolean;
  group_category_id?: number | null;
}

export interface CanvasRubricCriterion {
  id: string;
  description: string;
  long_description?: string | null;
  points: number;
  ratings?: Array<{ id: string; description: string; long_description?: string | null; points: number }>;
}

export interface CanvasSubmissionDetail extends CanvasSubmission {
  attempt: number | null;
  grade: string | null;
  excused?: boolean;
  points_deducted?: number | null;
  posted_at?: string | null;
  submission_comments?: Array<{ author_name: string; comment: string; created_at: string }>;
  rubric_assessment?: Record<string, { points?: number | null; rating_id?: string | null; comments?: string | null }>;
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
  page_url?: string;
  url?: string;
  external_url?: string;
  position: number;
  indent?: number;
  completion_requirement?: { type: string; completed?: boolean };
  content_details?: { due_at?: string | null; points_possible?: number | null; locked_for_user?: boolean };
}

export interface CanvasModule {
  id: number;
  name: string;
  position: number;
  items?: CanvasModuleItem[];
  state?: string;
  unlock_at?: string | null;
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
