/**
 * Calls every tool against a real Canvas account and fails on any error.
 *
 *   npm run check:live                         # in-process, uses .dev.vars
 *   MCP_URL=https://.../mcp MCP_PASSPHRASE=... npm run check:remote
 *
 * Ids for follow-up calls (course, assignment, quiz, topic, ...) are
 * discovered from earlier outputs, so it works on any student account. A
 * step whose prerequisite id was never found is skipped, not failed. Output
 * sizes are printed as a rough token cost per call.
 */
import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCanvasClientFromEnv } from "../src/canvas/client.js";
import { createCanvasMcpServer } from "../src/mcp/server.js";

type Vars = Record<string, string | undefined>;
type Step = {
  tool: string;
  args: (ids: Vars) => Record<string, unknown> | null;
  /** Regexes whose first capture group is saved under the key for later steps. */
  capture?: Record<string, RegExp>;
};

const STEPS: Step[] = [
  { tool: "list_courses", args: () => ({}) },
  { tool: "get_grades", args: () => ({}), capture: { course: /^- (\d+) .*: \d/m } },
  { tool: "get_grades", args: (v) => (v.course ? { course_id: Number(v.course) } : null), capture: { assignment: /^- (\d+) .* · (?:\d|-)/m } },
  { tool: "calculate_grade", args: (v) => (v.course ? { course_id: Number(v.course), target_percent: 90 } : null) },
  { tool: "get_upcoming", args: () => ({ days: 14, include_done: true }) },
  { tool: "get_missing_work", args: () => ({}) },
  { tool: "find_assignment", args: () => ({ query: "assignment" }) },
  { tool: "get_assignment", args: (v) => (v.course && v.assignment ? { course_id: Number(v.course), assignment_id: Number(v.assignment) } : null) },
  { tool: "gather_assignment_context", args: (v) => (v.course && v.assignment ? { course_id: Number(v.course), assignment_id: Number(v.assignment) } : null) },
  { tool: "list_modules", args: (v) => (v.course ? { course_id: Number(v.course) } : null), capture: { file: /file_id=(\d+)/, page: /page_url=([^)\s]+)/ } },
  { tool: "get_page", args: (v) => (v.course ? { course_id: Number(v.course) } : null) },
  { tool: "get_page", args: (v) => (v.course && v.page ? { course_id: Number(v.course), page_url: v.page } : null) },
  { tool: "get_page", args: (v) => (v.course ? { course_id: Number(v.course), page_url: "syllabus" } : null) },
  { tool: "list_files", args: (v) => (v.course ? { course_id: Number(v.course), limit: 10 } : null) },
  { tool: "get_file_text", args: (v) => (v.file ? { file_id: Number(v.file) } : null) },
  { tool: "search_course", args: (v) => (v.course ? { course_id: Number(v.course), query: "exam" } : null) },
  { tool: "get_quizzes", args: (v) => (v.course ? { course_id: Number(v.course) } : null), capture: { quiz: /quiz_id=(\d+)/ } },
  { tool: "get_quizzes", args: (v) => (v.course && v.quiz ? { course_id: Number(v.course), quiz_id: Number(v.quiz) } : null) },
  { tool: "list_announcements", args: () => ({ limit: 5 }), capture: { annCourse: /course_id=(\d+) topic_id=\d+/, ann: /course_id=\d+ topic_id=(\d+)/ } },
  { tool: "get_discussions", args: (v) => (v.annCourse && v.ann ? { course_id: Number(v.annCourse), topic_id: Number(v.ann), max_entries: 5 } : null) },
  { tool: "get_discussions", args: (v) => (v.course ? { course_id: Number(v.course) } : null) },
  { tool: "get_inbox", args: () => ({ limit: 3 }), capture: { conversation: /conversation_id=(\d+)/ } },
  { tool: "get_inbox", args: (v) => (v.conversation ? { conversation_id: Number(v.conversation) } : null) },
  { tool: "get_groups", args: () => ({}), capture: { group: /group_id=(\d+)/ } },
  { tool: "get_groups", args: (v) => (v.group ? { group_id: Number(v.group) } : null) },
  { tool: "list_people", args: (v) => (v.course ? { course_id: Number(v.course) } : null) },
  { tool: "get_recent_activity", args: () => ({ limit: 5 }) },
];

function loadDevVars(path = ".dev.vars"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
  }
}

async function connect(): Promise<{ client: Client; mode: string }> {
  const client = new Client({ name: "live-check", version: "0" });
  const url = process.env.MCP_URL;
  if (url) {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_PASSPHRASE ?? ""}` } },
    });
    await client.connect(transport);
    return { client, mode: `remote ${new URL(url).host}` };
  }
  loadDevVars();
  const server = createCanvasMcpServer(createCanvasClientFromEnv(process.env), { timeZone: process.env.CANVAS_TIME_ZONE });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, mode: "in-process" };
}

async function main() {
  const { client, mode } = await connect();
  const ids: Vars = { course: process.env.LIVE_COURSE_ID };
  const { tools } = await client.listTools();
  const listed = new Set(tools.map((t) => t.name));
  console.log(`live check (${mode}): ${tools.length} tools listed, ${JSON.stringify(tools).length} chars`);

  let failed = 0;
  let skipped = 0;
  const exercised = new Set<string>();
  for (const step of STEPS) {
    const args = step.args(ids);
    if (!args) {
      skipped++;
      console.log(`SKIP ${step.tool} (no id discovered)`);
      continue;
    }
    if (!listed.has(step.tool)) {
      failed++;
      console.log(`FAIL ${step.tool}: not listed by server`);
      continue;
    }
    const started = Date.now();
    try {
      const result = await client.callTool({ name: step.tool, arguments: args });
      const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
      const ms = Date.now() - started;
      if (result.isError) {
        failed++;
        console.log(`FAIL ${step.tool} ${JSON.stringify(args)} (${ms}ms): ${text.slice(0, 300)}`);
        continue;
      }
      exercised.add(step.tool);
      for (const [key, re] of Object.entries(step.capture ?? {})) {
        if (!ids[key]) ids[key] = text.match(re)?.[1];
      }
      console.log(`PASS ${step.tool.padEnd(26)} ${String(ms).padStart(6)}ms ${String(Math.round(text.length / 4)).padStart(6)} tok  ${JSON.stringify(args)}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${step.tool} ${JSON.stringify(args)}: ${(err as Error).message.slice(0, 300)}`);
    }
  }
  const unexercised = [...listed].filter((t) => !exercised.has(t));
  console.log(`\n${exercised.size}/${listed.size} tools exercised, ${failed} failed, ${skipped} skipped${unexercised.length ? `; not exercised: ${unexercised.join(", ")}` : ""}`);
  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("live check crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
