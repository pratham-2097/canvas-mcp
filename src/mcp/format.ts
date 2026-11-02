import { htmlToMarkdown } from "../canvas/html.js";

/**
 * Compact local-time date, e.g. "Tue Nov 4 11:59pm" (year added when it is
 * not the current one). Canvas returns UTC; students think in local time,
 * and "due 03:59Z" is both longer and easy to misread as the wrong day.
 */
export function fmtDate(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "no date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unreadable date";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const currentYear = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(new Date());
  const minute = parts.minute === "00" ? "" : `:${parts.minute}`;
  const year = parts.year === currentYear ? "" : ` ${parts.year}`;
  return `${parts.weekday} ${parts.month} ${parts.day}${year} ${parts.hour}${minute}${(parts.dayPeriod ?? "").toLowerCase()}`;
}

/** Markdown of a Canvas HTML body, cut to `max` chars. */
export function mdPreview(html: string | null | undefined, max: number): string {
  const md = htmlToMarkdown(html ?? "").trim();
  return clip(md, max);
}

export function clip(text: string, max: number): string {
  const flat = text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
  return flat;
}

/** Single-line preview for list rows. */
export function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}

/** "18", "18.5", "87.53" */
export function num(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const text = value.toFixed(decimals).replace(/\.?0+$/, "");
  return text === "-0" || text === "" ? "0" : text;
}

/** Runs `fn` over `items` with at most `limit` in flight (Workers cap concurrent subrequests). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
