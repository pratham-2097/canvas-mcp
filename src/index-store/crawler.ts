import type { CanvasClient } from "../canvas/client.js";
import {
  getCourseWithSyllabus,
  getFile,
  getPage,
  listAnnouncements,
  listCourseAssignments,
  listDiscussionTopics,
  listModules,
  listPages,
} from "../canvas/endpoints.js";
import { extractLinks, htmlToMarkdown } from "../canvas/html.js";
import { extractFileText } from "../extract/index.js";
import type { CourseIndex, IndexedDocument } from "./types.js";

const MAX_FILE_FETCH_BYTES = 25 * 1024 * 1024;

async function fetchAndExtractFile(
  client: CanvasClient,
  fileId: number,
): Promise<{ text: string; note?: string; filename: string; html_url: string; updated_at: string } | undefined> {
  try {
    const meta = await getFile(client, fileId);
    if (meta.size > MAX_FILE_FETCH_BYTES) {
      return { text: "", note: "file exceeds 25MB, not extracted", filename: meta.filename, html_url: meta.url, updated_at: meta.updated_at };
    }
    const download = await client.getBytes(meta.url);
    if (!download.ok) return undefined;
    const result = await extractFileText(meta.filename, meta["content-type"], download.bytes);
    return { text: result.text, note: result.note, filename: meta.filename, html_url: meta.url, updated_at: meta.updated_at };
  } catch {
    return undefined;
  }
}

/**
 * Crawls everything a Canvas course exposes and builds a flat document index.
 * Files are discovered by extracting links out of HTML bodies (descriptions,
 * pages, announcements, discussions) rather than listing /files, since that
 * endpoint is frequently 403'd for students even though individual file ids
 * discovered elsewhere are readable.
 */
export async function crawlCourse(client: CanvasClient, courseId: number): Promise<CourseIndex> {
  const documents: IndexedDocument[] = [];
  const seenFileIds = new Set<number>();

  async function indexFileIfNew(fileId: number) {
    if (seenFileIds.has(fileId)) return;
    seenFileIds.add(fileId);
    const extracted = await fetchAndExtractFile(client, fileId);
    if (!extracted) return;
    documents.push({
      id: `file-${fileId}`,
      course_id: courseId,
      type: "file",
      title: extracted.filename,
      html_url: extracted.html_url,
      text: extracted.note ? `[${extracted.note}]` : extracted.text,
      updated_at: extracted.updated_at,
    });
  }

  async function harvestLinks(html: string | null | undefined) {
    if (!html) return;
    const links = extractLinks(html);
    for (const link of links) {
      if (link.kind === "file" && link.fileId) {
        await indexFileIfNew(link.fileId);
      }
    }
  }

  const [course, assignments, modules, pages, announcements, discussions] = await Promise.all([
    getCourseWithSyllabus(client, courseId).catch(() => undefined),
    listCourseAssignments(client, courseId).catch(() => []),
    listModules(client, courseId).catch(() => []),
    listPages(client, courseId).catch(() => []),
    listAnnouncements(client, courseId).catch(() => []),
    listDiscussionTopics(client, courseId).catch(() => []),
  ]);

  if (course?.syllabus_body) {
    documents.push({
      id: `syllabus-${courseId}`,
      course_id: courseId,
      type: "syllabus",
      title: `${course.name} — Syllabus`,
      html_url: `https://uc.instructure.com/courses/${courseId}/assignments/syllabus`,
      text: htmlToMarkdown(course.syllabus_body),
      updated_at: new Date().toISOString(),
    });
    await harvestLinks(course.syllabus_body);
  }

  const moduleNameByItemId = new Map<number, string>();
  for (const mod of modules) {
    for (const item of mod.items ?? []) {
      moduleNameByItemId.set(item.id, mod.name);
      if (item.type === "File" && typeof item.content_id === "number") {
        await indexFileIfNew(item.content_id);
      } else {
        documents.push({
          id: `module_item-${item.id}`,
          course_id: courseId,
          type: "module_item",
          title: item.title,
          html_url: item.html_url,
          module: mod.name,
          text: `${item.type}: ${item.title}`,
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  for (const a of assignments) {
    documents.push({
      id: `assignment-${a.id}`,
      course_id: courseId,
      type: "assignment",
      title: a.name,
      html_url: a.html_url,
      text: `${a.name}\n\n${htmlToMarkdown(a.description ?? "")}`,
      updated_at: new Date().toISOString(),
    });
    await harvestLinks(a.description);
  }

  for (const p of pages) {
    const full = await getPage(client, courseId, p.url).catch(() => undefined);
    const body = full?.body ?? "";
    documents.push({
      id: `page-${p.page_id}`,
      course_id: courseId,
      type: "page",
      title: p.title,
      html_url: p.html_url,
      text: `${p.title}\n\n${htmlToMarkdown(body)}`,
      updated_at: p.updated_at,
    });
    await harvestLinks(body);
  }

  for (const ann of announcements) {
    documents.push({
      id: `announcement-${ann.id}`,
      course_id: courseId,
      type: "announcement",
      title: ann.title,
      html_url: ann.html_url,
      text: `${ann.title}\n\n${htmlToMarkdown(ann.message ?? "")}`,
      updated_at: ann.posted_at,
    });
    await harvestLinks(ann.message);
  }

  for (const d of discussions) {
    documents.push({
      id: `discussion-${d.id}`,
      course_id: courseId,
      type: "discussion",
      title: d.title,
      html_url: d.html_url,
      text: `${d.title}\n\n${htmlToMarkdown(d.message ?? "")}`,
      updated_at: d.posted_at ?? new Date().toISOString(),
    });
    await harvestLinks(d.message);
  }

  return { course_id: courseId, documents, indexed_at: Date.now() };
}
