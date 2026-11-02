# canvas-mcp

A personal, read-only, remote MCP server for a University of Cincinnati Canvas account. It lets an AI assistant (Claude.ai, ChatGPT, Gemini CLI, Claude Code, Cursor) see what's due and missing, check grades and run exact what-if / target-grade math, pull everything about an assignment (description, rubric, your submission and feedback, module context, linked files and pages with extracted text), read quizzes, discussions, announcements, inbox, groups and calendar, and full-text search a course — including text inside PDFs, DOCX and PPTX.

It covers every student *read* feature of [vishalsachdev/canvas-mcp](https://github.com/vishalsachdev/canvas-mcp) in 20 tools (~2.5k tokens of tool definitions), instead of ~45.

The server is strictly **read-only**: the Canvas HTTP client only ever issues `GET` requests.

## How it works

- **Canvas client** (`src/canvas/`) — a GET-only HTTP client with pagination (`Link` header, `per_page=100`) and 429 backoff.
- **Extraction** (`src/extract/`) — pulls text out of PDF (`unpdf`), DOCX (`mammoth`), PPTX (unzipped with `fflate`, slide XML parsed by hand), and plain text/code files. Files over 25MB or without extractable text are marked, not processed.
- **Index & search** (`src/index-store/`) — a lazy per-course crawler builds a flat document index (assignments, pages, files, announcements, discussions, syllabus, module items), discovering files by extracting `/files/:id` and `/pages/:url` links out of HTML bodies rather than listing `/files` directly, since that endpoint is often 403'd for students even when individual Canvas courses hide their Files tab. Chunked (~1500 chars, overlapping) and ranked with BM25. Cached in-memory with a 6h TTL; `force_refresh` bypasses it.
- **Grade engine** (`src/grades/calc.ts`) — a pure port of Canvas's grade arithmetic (weighted groups with rescaling, drop lowest/highest/never-drop by best ratio, excused/unposted/omitted work, Ruby rounding, points-based schemes) plus a target solver. Output is checked against Canvas's own score and disagreements are flagged.
- **MCP tools** (`src/mcp/tools/`) — 20 tools, all read-only, all zod-validated, all capped at ~20k output chars with a truncation note. Registered through `src/mcp/registry.ts`, which serves a slimmed `tools/list`.

## Setup

```bash
npm install
cp .env.example .dev.vars
```

Open `.dev.vars` and fill in:

- `CANVAS_TOKEN` — generate at **UC Canvas → Account → Settings → + New Access Token**. Never commit this file (it's gitignored); never paste the token into a chat with an AI assistant.
- `CANVAS_BASE_URL` — already set to `https://uc.instructure.com/api/v1`.
- `ACCESS_PASSPHRASE` — only needed for the deployed HTTP version (see below). Generate one with `openssl rand -hex 32`.

### Run locally over stdio

```bash
npm run dev:stdio
```

### Inspect it

```bash
npm run inspector
```

Opens MCP Inspector against the stdio server so you can call tools by hand and see real output against your account.

### Run tests

```bash
npm test             # unit + tool tests against a fake Canvas (no network)
npm run check:live   # call every tool against your real Canvas via .dev.vars
npm run footprint    # tool-list size per tool, in chars and ~tokens
npm run call -- get_grades '{"course_id":"cloud"}'   # one real call
```

`npm test` covers the Canvas client (pagination, 429 backoff), link extraction, BM25 search, the grade engine (hand-checked weighted/drop/target cases), all 20 tools end-to-end through an MCP client against a recorded fake Canvas, the read-only invariant (only GETs; inbox reads pass `auto_mark_as_read=false`), and the tool-list token budget.

`check:live` discovers real ids as it goes (course → assignment → file, quiz, topic, conversation, group) and prints latency and output size per call. Set `MCP_URL` and `MCP_PASSPHRASE` to run the same check against the deployed Worker (`npm run check:remote`).

### CI and automatic deploys

`.github/workflows/ci.yml` runs typecheck + tests on every push and PR. On `main` it deploys with Wrangler and then runs the live check against the deployed server; it also re-runs the live check daily, so an expired Canvas token shows up as a failed run rather than mid-conversation. Add these repository secrets to enable it (jobs without their secrets are skipped):

```bash
gh secret set CLOUDFLARE_API_TOKEN    # dash.cloudflare.com → My Profile → API Tokens → "Edit Cloudflare Workers"
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set MCP_URL                 # https://canvas-mcp.<subdomain>.workers.dev/mcp
gh secret set MCP_PASSPHRASE          # same value as ACCESS_PASSPHRASE
```

Claude.ai re-reads the tool list when a conversation starts, so a deploy is picked up by the next new chat.

## Deploying to Cloudflare Workers

The remote server runs on Cloudflare Workers using the MCP SDK's `WebStandardStreamableHTTPServerTransport` directly (no Durable Objects, no KV needed — it's stateless, a fresh transport per request). Auth is a single shared-secret check: the Worker compares the `Authorization: Bearer <token>` header against `ACCESS_PASSPHRASE`. This is intentionally simpler than a full OAuth provider flow, which exists to support multiple distinct clients/users — unnecessary for a single-user personal server.

```bash
npx wrangler login          # once, if not already logged in
npx wrangler secret put CANVAS_TOKEN
npx wrangler secret put CANVAS_BASE_URL   # https://uc.instructure.com/api/v1
npx wrangler secret put ACCESS_PASSPHRASE
npm run deploy
```

Wrangler prints the deployed URL, e.g. `https://canvas-mcp.<your-subdomain>.workers.dev`. The only route is `POST/GET /mcp`; everything else 404s.

### Verify the deployment

```bash
curl -i https://canvas-mcp.<your-subdomain>.workers.dev/mcp
# -> 401 Unauthorized (no Authorization header)

curl -s -X POST https://canvas-mcp.<your-subdomain>.workers.dev/mcp \
  -H "Authorization: Bearer <your ACCESS_PASSPHRASE>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
# -> {"result":{"protocolVersion":"2025-06-18", ...
```

Or point MCP Inspector's "Streamable HTTP" transport at the deployed URL with the passphrase as a bearer token in the Authorization header field.

## Connecting a client

All clients need the deployed URL (`https://canvas-mcp.<your-subdomain>.workers.dev/mcp`) and your `ACCESS_PASSPHRASE` as a bearer token.

### Claude.ai

Settings → Connectors → Add custom connector → paste the URL. When prompted for auth, choose a bearer/API-key style header and paste the passphrase.

### ChatGPT

Settings → Connectors → Add → enter the URL as a custom MCP connector, with the passphrase as the bearer token (requires a ChatGPT plan that supports custom connectors).

### Claude Code

```bash
claude mcp add --transport http canvas-mcp https://canvas-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <your ACCESS_PASSPHRASE>"
```

### Gemini CLI

Add to your Gemini CLI MCP config (`~/.gemini/settings.json` or equivalent) as an HTTP server entry pointing at the URL, with the Authorization header set to `Bearer <your ACCESS_PASSPHRASE>`.

### Cursor

Cursor Settings → MCP → Add new MCP server → type "http" (or "streamable-http") → paste the URL and add the Authorization header.

## Example prompts

- "What am I missing right now across all my classes?"
- "Everything I need to know about Project 1 in Computer Graphics."
- "Search my Networks course for anything about subnetting."
- "What's the syllabus grading breakdown for Senior Design?"
- "Find the assignment called 'design doc' and tell me what's due."
- "What do I need on the rest of Cloud Computing to get a B? What if I get 18/20 on Project 4?"
- "What's due this week, including class times?"
- "Did my professor reply in my inbox? Who's the TA for Networks and what's their email?"
- "What changed in my courses since yesterday — new grades or feedback?"

## Tools

Every `course_id` also accepts a course name or code fragment (`"cloud"`, `"CS5165"`, `"senior design"`), so the model rarely needs a `list_courses` round-trip.

| Tool | Purpose | Reference features it covers |
|---|---|---|
| `get_upcoming` | Assignments, quizzes, discussions, peer reviews, class events and planner notes in a window, with submit status | upcoming assignments, todo items, submission status, peer reviews todo, calendar events, planner notes |
| `get_missing_work` | Missing/overdue work across courses | — |
| `get_grades` | All-course scores, or every assignment in a course by group with score/status/due | course grades, assignment scores, list assignments |
| `calculate_grade` | Canvas-exact recompute, what-if scores, % needed for a target % or letter | grade scenarios |
| `list_courses` | Profile + courses with term and role | profile, enrollments, list courses |
| `find_assignment` | Fuzzy name match across courses | — |
| `get_assignment` | Details, compact rubric, your submission, attempts, comments, rubric scores | assignment details, my submission, rubric assessment |
| `gather_assignment_context` | One-call bundle for working on an assignment | — |
| `search_course` | BM25 full-text search incl. file contents | course content overview |
| `list_modules` | Modules with item ids, due dates, completion ✓/☐ | course structure, module items |
| `get_page` | A page, `front_page`, `syllabus`, or the page list | pages, front page, syllabus |
| `list_files` | Course or group files | course files, group files |
| `get_file_text` | Extract text from a file, paged by `offset` | read/download file |
| `get_quizzes` | Classic + New Quizzes list, or one quiz with your attempts | list quizzes, quiz details |
| `get_discussions` | Topics (course or group), or a full threaded topic | discussion topics/entries/replies, group discussions |
| `list_announcements` | Announcements, all courses at once by default | announcements, my announcements |
| `get_inbox` | Conversations + unread count, or one thread (never marks read) | conversations, unread count |
| `get_groups` | Your groups, or one group's members | my groups, group members |
| `list_people` | Instructors/TAs (with email) or students | message recipients lookup |
| `get_recent_activity` | Dashboard feed: new grades, feedback, posts, messages | activity stream |

Deliberately not ported: write tools (submit, send message, post, planner edits) — this server is read-only by design — and educator/admin tools (grading, rubric/module/page authoring, analytics), which a student token cannot call.

## Token efficiency

Tool definitions are sent to the model on every turn, so they are kept lean:

- **20 tools instead of ~45**: list-vs-detail pairs share one tool (omit the id to list).
- **Slim `tools/list`**: `src/mcp/registry.ts` drops the SDK's `$schema`, int64 bounds, `execution`, `title` and redundant hints (~40% of each definition).
- **Budget test**: `test/footprint.test.ts` fails CI if the tool list exceeds ~2.9k tokens or a description grows too long. Run `npm run footprint` to see the per-tool cost.
- **Compact output**: local-time dates (`Wed Nov 4 11:59pm`), ids inline for follow-ups, no URLs in bulk lists, rubrics as one line per criterion, long files paged.
- **Caching across requests**: course list (10 min) and search indexes (6 h, LRU of 8 courses) live at Worker module scope, so they survive the stateless per-request transport. Large courses index incrementally within a 20 s budget per call.

## Known limitations

- No OCR — image-only PDFs are marked `image-only, not extracted`.
- External LTI tools (Kaltura, Gradescope, publisher sites) are reported as links, not scraped.
- Times are shown in `America/New_York`; set the `CANVAS_TIME_ZONE` secret to change it.
- Grade math does not reproduce grading-period weighting or instructor final-grade overrides; it says so and flags any disagreement with Canvas's own score.
- Search is BM25/keyword-based, not semantic; the document schema is shaped so embeddings could be added later without a redesign, but that isn't built.
- The `/courses/:id/files` listing endpoint is frequently 403'd by Canvas for students even when individual file IDs (discovered via links) are readable — this is a Canvas permission quirk, not a bug here.
