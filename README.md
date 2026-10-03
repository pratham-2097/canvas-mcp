# canvas-mcp

A personal, read-only, remote MCP server for a University of Cincinnati Canvas account. It lets an AI assistant (Claude.ai, ChatGPT, Gemini CLI, Claude Code, Cursor) see missing/overdue work, pull everything about a specific assignment (description, rubric, module context, linked pages and files with extracted text, related announcements), and run full-text search across a course — including text extracted from PDFs, DOCX, and PPTX files.

The server is strictly **read-only**: the Canvas HTTP client only ever issues `GET` requests.

## How it works

- **Canvas client** (`src/canvas/`) — a GET-only HTTP client with pagination (`Link` header, `per_page=100`) and 429 backoff.
- **Extraction** (`src/extract/`) — pulls text out of PDF (`unpdf`), DOCX (`mammoth`), PPTX (unzipped with `fflate`, slide XML parsed by hand), and plain text/code files. Files over 25MB or without extractable text are marked, not processed.
- **Index & search** (`src/index-store/`) — a lazy per-course crawler builds a flat document index (assignments, pages, files, announcements, discussions, syllabus, module items), discovering files by extracting `/files/:id` and `/pages/:url` links out of HTML bodies rather than listing `/files` directly, since that endpoint is often 403'd for students even when individual Canvas courses hide their Files tab. Chunked (~1500 chars, overlapping) and ranked with BM25. Cached in-memory with a 6h TTL; `force_refresh` bypasses it.
- **MCP tools** (`src/mcp/tools/`) — 12 tools, all read-only, all zod-validated, all capped at ~20k output chars with a truncation note.

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
npm test
```

Covers pagination (Link-header following, 429 retry/backoff), link extraction/classification (file vs. page vs. external), and BM25 search ranking.

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

## Tools

| Tool | Purpose |
|---|---|
| `list_courses` | Active courses + term info |
| `get_missing_work` | Missing/overdue/unsubmitted, sorted by due date |
| `find_assignment` | Fuzzy name match across courses |
| `get_assignment` | One assignment's full details + resolved links |
| `gather_assignment_context` | Everything about one assignment: module, neighbors, linked files/pages, course-wide mentions |
| `search_course` | Full-text BM25 search over a course's indexed content |
| `list_modules` | A course's modules and items |
| `get_page` | One wiki page as markdown |
| `get_file_text` | Download + extract text from one file by id |
| `list_announcements` | A course's announcements |
| `get_syllabus` | A course's syllabus body as markdown |
| `refresh_course_index` | Force a re-crawl, bypassing the 6h cache |

## Known limitations

- No OCR — image-only PDFs are marked `image-only, not extracted`.
- External LTI tools (Kaltura, Gradescope, publisher sites) are reported as links, not scraped.
- Search is BM25/keyword-based, not semantic; the document schema is shaped so embeddings could be added later without a redesign, but that isn't built.
- The `/courses/:id/files` listing endpoint is frequently 403'd by Canvas for students even when individual file IDs (discovered via links) are readable — this is a Canvas permission quirk, not a bug here.
