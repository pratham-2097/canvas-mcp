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
import { mapLimit } from "../mcp/format.js";
import type { CourseIndex, IndexedDocument } from "./types.js";

const MAX_FILE_FETCH_BYTES = 25 * 1024 * 1024;
const CONCURRENCY = 6;

export interface CrawlOptions {
  /** Stop starting new file extractions after this many ms; the rest stay pending for the next crawl. */
  fileBudgetMs?: number;
  /**
   * Most files to extract in one crawl. Cloudflare's free plan allows 50
   * subrequests and little CPU per request, and every file costs two
   * requests plus parsing, so the Worker sets this low.
   */
  maxFiles?: number;
}

type FileOutcome = { doc: IndexedDocument } | { pending: true } | { failed: true };

async function fetchAndExtractFile(client: CanvasClient, courseId: number, fileId: number): Promise<FileOutcome> {
  try {
    const meta = await getFile(client, fileId);
    const base = { id: `file-${fileId}`, course_id: courseId, type: "file" as const, title: meta.filename, html_url: meta.url, updated_at: meta.updated_at };
    if (meta.size > MAX_FILE_FETCH_BYTES) return { doc: { ...base, text: "[file exceeds 25MB, not extracted]" } };
    const download = await client.getBytes(meta.url);
    if (!download.ok) return { failed: true };
    const result = await extractFileText(meta.filename, meta["content-type"], download.bytes);
    return { doc: { ...base, text: result.note ? `[${result.note}]` : result.text } };
  } catch (err) {
    // Workers cap subrequests per invocation; a file that hit the cap is
    // retried on the next crawl rather than dropped.
    return /subrequest/i.test((err as Error).message) ? { pending: true } : { failed: true };
  }
}

/**
 * Crawls everything a Canvas course exposes and builds a flat document index.
 * Files are discovered by extracting links out of HTML bodies (descriptions,
 * pages, announcements, discussions) and from modules, rather than listing
 * /files, since that endpoint is frequently 403'd for students even though
 * individual file ids discovered elsewhere are readable.
 *
 * Listings and page bodies are fetched concurrently; files are extracted
 * concurrently within a time and count budget. Files left over are kept in
 * `pending_file_ids` and extracted by continueCrawl on later calls, so a
 * large course is indexed incrementally instead of timing out.
 */
export async function crawlCourse(client: CanvasClient, courseId: number, options: CrawlOptions = {}): Promise<CourseIndex> {
  const documents: IndexedDocument[] = [];
  const fileIds = new Set<number>();
  const now = new Date().toISOString();

  const harvestLinks = (html: string | null | undefined) => {
    for (const link of extractLinks(html ?? "")) {
      if (link.kind === "file" && link.fileId) fileIds.add(link.fileId);
    }
  };

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
      updated_at: now,
    });
    harvestLinks(course.syllabus_body);
  }

  for (const mod of modules) {
    for (const item of mod.items ?? []) {
      if (item.type === "File" && typeof item.content_id === "number") fileIds.add(item.content_id);
      // File items are indexed by name too, so they stay findable (with the
      // id get_file_text needs) even when their contents are not extracted.
      const ref = item.type === "File" ? ` (file_id=${item.content_id})` : "";
      documents.push({
        id: `module_item-${item.id}`,
        course_id: courseId,
        type: "module_item",
        title: item.title,
        html_url: item.html_url,
        module: mod.name,
        text: `${item.type}: ${item.title}${ref}`,
        updated_at: now,
      });
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
      updated_at: now,
    });
    harvestLinks(a.description);
  }

  const pageBodies = await mapLimit(pages, CONCURRENCY, (p) => getPage(client, courseId, p.url).then((full) => full.body ?? "").catch(() => ""));
  pages.forEach((p, i) => {
    const body = pageBodies[i] ?? "";
    documents.push({
      id: `page-${p.url}`,
      course_id: courseId,
      type: "page",
      title: p.title,
      html_url: p.html_url,
      text: `${p.title}\n\n${htmlToMarkdown(body)}`,
      updated_at: p.updated_at,
    });
    harvestLinks(body);
  });

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
    harvestLinks(ann.message);
  }

  for (const d of discussions) {
    documents.push({
      id: `discussion-${d.id}`,
      course_id: courseId,
      type: "discussion",
      title: d.title,
      html_url: d.html_url,
      text: `${d.title}\n\n${htmlToMarkdown(d.message ?? "")}`,
      updated_at: d.posted_at ?? now,
    });
    harvestLinks(d.message);
  }

  const { docs, pending } = await extractFiles(client, courseId, [...fileIds], options);
  documents.push(...docs);
  return { course_id: courseId, documents, indexed_at: Date.now(), pending_file_ids: pending };
}

/**
 * Extracts an incomplete index's pending files without re-fetching any
 * course listings, so a continuation spends its whole request budget on files.
 */
export async function continueCrawl(client: CanvasClient, index: CourseIndex, options: CrawlOptions = {}): Promise<CourseIndex> {
  const { docs, pending } = await extractFiles(client, index.course_id, index.pending_file_ids ?? [], options);
  return { ...index, documents: [...index.documents, ...docs], pending_file_ids: pending };
}

async function extractFiles(
  client: CanvasClient,
  courseId: number,
  fileIds: number[],
  options: CrawlOptions,
): Promise<{ docs: IndexedDocument[]; pending: number[] }> {
  const batch = fileIds.slice(0, options.maxFiles ?? fileIds.length);
  const pending = fileIds.slice(batch.length);
  const deadline = Date.now() + (options.fileBudgetMs ?? Number.POSITIVE_INFINITY);
  const docs: IndexedDocument[] = [];
  const outcomes = await mapLimit(batch, CONCURRENCY, async (fileId): Promise<FileOutcome> => {
    if (Date.now() > deadline) return { pending: true };
    return fetchAndExtractFile(client, courseId, fileId);
  });
  outcomes.forEach((outcome, i) => {
    if ("doc" in outcome) docs.push(outcome.doc);
    else if ("pending" in outcome) pending.push(batch[i]!);
  });
  return { docs, pending };
}
