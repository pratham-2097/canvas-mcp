import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { unzipSync, strFromU8 } from "fflate";

export const MAX_EXTRACTABLE_BYTES = 25 * 1024 * 1024;

export type ExtractionStatus = "ok" | "skipped_too_large" | "skipped_binary" | "image_only" | "unsupported" | "error";

export interface ExtractionResult {
  status: ExtractionStatus;
  text: string;
  note?: string;
}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "json", "yaml", "yml",
  "js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h", "hpp",
  "cs", "go", "rs", "rb", "php", "html", "css", "sql", "sh",
]);

function extOf(filename: string): string {
  const match = filename.match(/\.([a-zA-Z0-9]+)$/);
  return match?.[1] ? match[1].toLowerCase() : "";
}

function okResult(text: string): ExtractionResult {
  const trimmed = text.trim();
  if (!trimmed) return { status: "image_only", text: "", note: "image-only, not extracted" };
  return { status: "ok", text: trimmed };
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return okResult(Array.isArray(text) ? text.join("\n") : text);
  } catch (err) {
    return { status: "error", text: "", note: `PDF extraction failed: ${(err as Error).message}` };
  }
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractionResult> {
  try {
    const buffer = Buffer.from(bytes);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const result = await mammoth.extractRawText({ buffer, arrayBuffer } as never);
    return okResult(result.value);
  } catch (err) {
    return { status: "error", text: "", note: `DOCX extraction failed: ${(err as Error).message}` };
  }
}

const SLIDE_XML_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const TEXT_RUN_RE = /<a:t>([^<]*)<\/a:t>/g;

async function extractPptx(bytes: Uint8Array): Promise<ExtractionResult> {
  try {
    const unzipped = unzipSync(bytes);
    const slideEntries = Object.keys(unzipped)
      .filter((name) => SLIDE_XML_RE.test(name))
      .sort((a, b) => {
        const na = Number(a.match(SLIDE_XML_RE)![1]);
        const nb = Number(b.match(SLIDE_XML_RE)![1]);
        return na - nb;
      });

    const slideTexts: string[] = [];
    for (const entry of slideEntries) {
      const data = unzipped[entry];
      if (!data) continue;
      const xml = strFromU8(data);
      const runs: string[] = [];
      for (const match of xml.matchAll(TEXT_RUN_RE)) {
        if (match[1]) runs.push(match[1]);
      }
      if (runs.length > 0) slideTexts.push(runs.join(" "));
    }

    return okResult(slideTexts.map((t, i) => `[Slide ${i + 1}]\n${t}`).join("\n\n"));
  } catch (err) {
    return { status: "error", text: "", note: `PPTX extraction failed: ${(err as Error).message}` };
  }
}

function extractPlainText(bytes: Uint8Array): ExtractionResult {
  return okResult(strFromU8(bytes));
}

/**
 * Extracts text from a file's raw bytes based on its filename extension.
 * Caller is responsible for the 25MB size check before calling (we also
 * defensively check here).
 */
export async function extractFileText(filename: string, contentType: string, bytes: Uint8Array): Promise<ExtractionResult> {
  if (bytes.byteLength > MAX_EXTRACTABLE_BYTES) {
    return { status: "skipped_too_large", text: "", note: "file exceeds 25MB, not extracted" };
  }

  const ext = extOf(filename);

  if (ext === "pdf" || contentType === "application/pdf") {
    return extractPdf(bytes);
  }

  if (ext === "docx" || contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return extractDocx(bytes);
  }

  if (ext === "pptx" || contentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return extractPptx(bytes);
  }

  if (TEXT_EXTENSIONS.has(ext) || contentType.startsWith("text/")) {
    return extractPlainText(bytes);
  }

  return { status: "skipped_binary", text: "", note: `unsupported file type (.${ext || "unknown"}), not extracted` };
}
