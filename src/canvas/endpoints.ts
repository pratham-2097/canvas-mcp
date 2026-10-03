import type { CanvasClient } from "./client.js";
import type {
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasCourse,
  CanvasCourseWithSyllabus,
  CanvasDiscussionTopic,
  CanvasFile,
  CanvasMissingSubmission,
  CanvasModule,
  CanvasPage,
} from "./types.js";

export async function listActiveCourses(client: CanvasClient): Promise<CanvasCourse[]> {
  return client.getPaginated<CanvasCourse>("/courses", {
    enrollment_state: "active",
    include: ["term"],
  });
}

export async function getMissingSubmissions(
  client: CanvasClient,
): Promise<CanvasMissingSubmission[]> {
  return client.getPaginated<CanvasMissingSubmission>("/users/self/missing_submissions", {
    include: ["course"],
  });
}

export type AssignmentBucket = "past" | "overdue" | "undated" | "ungraded" | "unsubmitted" | "upcoming" | "future";

export async function listCourseAssignments(
  client: CanvasClient,
  courseId: number,
  bucket?: AssignmentBucket,
): Promise<CanvasAssignment[]> {
  return client.getPaginated<CanvasAssignment>(`/courses/${courseId}/assignments`, {
    bucket,
    include: ["submission"],
  });
}

export async function getAssignment(
  client: CanvasClient,
  courseId: number,
  assignmentId: number,
): Promise<CanvasAssignment> {
  return client.get<CanvasAssignment>(`/courses/${courseId}/assignments/${assignmentId}`, {
    include: ["submission", "rubric"],
  });
}

export async function listModules(client: CanvasClient, courseId: number): Promise<CanvasModule[]> {
  return client.getPaginated<CanvasModule>(`/courses/${courseId}/modules`, {
    include: ["items", "content_details"],
  });
}

export async function listPages(client: CanvasClient, courseId: number): Promise<CanvasPage[]> {
  return client.getPaginated<CanvasPage>(`/courses/${courseId}/pages`);
}

export async function getPage(
  client: CanvasClient,
  courseId: number,
  pageUrl: string,
): Promise<CanvasPage> {
  return client.get<CanvasPage>(`/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`);
}

export async function getFrontPage(client: CanvasClient, courseId: number): Promise<CanvasPage> {
  return client.get<CanvasPage>(`/courses/${courseId}/front_page`);
}

export async function listFiles(client: CanvasClient, courseId: number): Promise<CanvasFile[]> {
  return client.getPaginated<CanvasFile>(`/courses/${courseId}/files`);
}

export async function getFile(client: CanvasClient, fileId: number): Promise<CanvasFile> {
  return client.get<CanvasFile>(`/files/${fileId}`);
}

export async function listAnnouncements(
  client: CanvasClient,
  courseId: number,
  since?: string,
): Promise<CanvasAnnouncement[]> {
  return client.getPaginated<CanvasAnnouncement>("/announcements", {
    context_codes: [`course_${courseId}`],
    start_date: since,
  });
}

export async function listDiscussionTopics(
  client: CanvasClient,
  courseId: number,
): Promise<CanvasDiscussionTopic[]> {
  return client.getPaginated<CanvasDiscussionTopic>(`/courses/${courseId}/discussion_topics`);
}

export async function getCourseWithSyllabus(
  client: CanvasClient,
  courseId: number,
): Promise<CanvasCourseWithSyllabus> {
  return client.get<CanvasCourseWithSyllabus>(`/courses/${courseId}`, {
    include: ["syllabus_body", "term"],
  });
}
