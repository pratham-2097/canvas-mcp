import { NodeHtmlMarkdown } from "node-html-markdown-cloudflare";
import { parse } from "node-html-parser";

export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  return NodeHtmlMarkdown.translate(html);
}

export type ResolvedLinkKind = "file" | "page" | "external";

export interface ResolvedLink {
  kind: ResolvedLinkKind;
  href: string;
  text: string;
  /** Canvas file id, present when kind === "file" */
  fileId?: number;
  /** Canvas page url slug, present when kind === "page" */
  pageUrl?: string;
  /** Course id parsed out of the link path, when present */
  courseId?: number;
}

const FILE_PATH_RE = /\/courses\/(\d+)\/files\/(\d+)/;
const BARE_FILE_PATH_RE = /^\/files\/(\d+)/;
const PAGE_PATH_RE = /\/courses\/(\d+)\/pages\/([^/?#]+)/;

/**
 * Extracts and classifies every <a href> and <img src> in a block of Canvas
 * HTML. Canvas often hides the Files tab from students, so this is the only
 * reliable way to discover files/pages linked from a description or page body.
 */
export function extractLinks(html: string): ResolvedLink[] {
  if (!html) return [];
  const root = parse(html);
  const links: ResolvedLink[] = [];

  const anchorNodes = root.querySelectorAll("a");
  for (const node of anchorNodes) {
    const href = node.getAttribute("href");
    if (!href) continue;
    links.push(classifyLink(href, node.text.trim() || href));
  }

  const imgNodes = root.querySelectorAll("img");
  for (const node of imgNodes) {
    const src = node.getAttribute("src");
    if (!src) continue;
    links.push(classifyLink(src, node.getAttribute("alt") ?? src));
  }

  return links;
}

function classifyLink(href: string, text: string): ResolvedLink {
  const fileMatch = href.match(FILE_PATH_RE);
  if (fileMatch && fileMatch[1] && fileMatch[2]) {
    return { kind: "file", href, text, fileId: Number(fileMatch[2]), courseId: Number(fileMatch[1]) };
  }

  const bareFileMatch = href.match(BARE_FILE_PATH_RE);
  if (bareFileMatch && bareFileMatch[1]) {
    return { kind: "file", href, text, fileId: Number(bareFileMatch[1]) };
  }

  const pageMatch = href.match(PAGE_PATH_RE);
  if (pageMatch && pageMatch[1] && pageMatch[2]) {
    return { kind: "page", href, text, courseId: Number(pageMatch[1]), pageUrl: decodeURIComponent(pageMatch[2]) };
  }

  return { kind: "external", href, text };
}
