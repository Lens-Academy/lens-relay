# Add Video: YouTube Transcript Pipeline

## Problem

Adding YouTube video transcripts to the Lens Relay system currently requires:
1. Cloning the youtube-transcription-tool repository
2. Opening a Claude Code session there
3. Running Python scripts to fetch and format transcripts
4. Manually copying output files to an Obsidian vault via WinSCP
5. Waiting for Obsidian to sync to Lens Relay

This is too many steps, requires developer tooling, and is inaccessible to non-technical team members.

## Solution

A browser bookmarklet + server-side processing pipeline that lets any user add YouTube transcripts to Lens Relay in three clicks:

1. Navigate to YouTube, click the "Add to Lens" bookmarklet
2. Paste URLs (or use the current video), click "Fetch Transcripts"
3. Review and click "Send to Lens"

The bookmarklet extracts transcripts client-side (using the user's residential IP to avoid YouTube's datacenter IP blocking), sends the raw data to the Lens Relay VPS, where Claude Code formats the transcript and the server creates the final files in Relay.

## Architecture

```
User's browser (YouTube page)           Lens Relay VPS (Hetzner)
─────────────────────────────           ────────────────────────
Bookmarklet runs on youtube.com
  ├─ Calls youtubei/v1/player API
  │  (same-origin, no CORS issues)
  ├─ Gets fresh timedtext URLs
  ├─ Fetches fmt=json3 transcript
  │  (word-level timestamps)
  ├─ Extracts title, channel, video ID
  └─ POSTs payload to server ─────────→ POST /api/add-video
                                           ├─ Validates payload
                                           ├─ Adds job to queue
                                           └─ Returns job ID

                                         Serial worker loop:
                                           ├─ Saves raw transcript to temp file
                                           ├─ Spawns claude --bare -p "..."
                                           │    Claude reads raw file
                                           │    Claude writes corrected.txt
                                           ├─ Runs timestamp alignment script
                                           ├─ Creates .md + .json in Relay
                                           │  via internal API or MCP
                                           └─ Updates job status → done

User polls GET /api/add-video/status ──→ Returns job statuses
```

## Components

### 1. Bookmarklet (browser-side JavaScript)

**Location:** `lens-editor/public/add-video-bookmarklet.js`
**Install page:** `lens-editor/public/add-video.html`

Runs on any YouTube page. Inlined into a `javascript:` bookmark URL (no external script loading — avoids CORS).

**Responsibilities:**
- Extract `INNERTUBE_API_KEY`, `INNERTUBE_CLIENT_VERSION`, and `VISITOR_DATA` from the YouTube page's embedded scripts
- For each video URL, call `youtubei/v1/player` to get fresh caption track URLs (the timedtext URLs embedded in `ytInitialPlayerResponse` return empty bodies; the player endpoint returns working ones)
- Fetch the transcript with `&fmt=json3` for word-level timestamps
- Extract video metadata: title, channel name, video ID
- Detect transcript type: `asr` (auto-generated, word-level) vs manual (sentence-level)
- Show an overlay panel with URL input, fetch progress, and JSON preview
- POST the payload to the server on user confirmation

**Trusted Types:** YouTube enforces Trusted Types CSP. The bookmarklet creates a `trustedTypes.createPolicy('lens-bm', ...)` policy and wraps all `innerHTML` assignments through it.

**Bulk support:** User pastes multiple YouTube URLs. The bookmarklet processes them sequentially (1s delay between requests) and shows per-video status.

**Prototype status:** Working. Tested with auto-generated and manual caption tracks. Produces identical `fmt=json3` data to the existing Python CLI tool.

### 2. Server Endpoint (lens-editor, Node.js/Hono)

**Location:** New route in `lens-editor/src/server/` (or `prod-server.ts`)

**Endpoints:**

`POST /api/add-video`
- Auth: same auth as lens-editor (Discord OAuth or share token)
- Body: `{ videos: [{ video_id, title, channel, url, transcript_type, transcript_raw }] }`
- Response: `{ jobs: [{ job_id, status: "queued", position, relay_url }] }`
- `relay_url` links directly to the placeholder document in the Relay editor (e.g., `https://editor.lensacademy.org/.../video_transcripts/channel-title.md`)

`GET /api/add-video/status`
- Auth: same
- Response: `{ jobs: [{ job_id, video_id, title, status, error?, result_path? }] }`

### 3. Job Queue

**In-memory queue** in the lens-editor Node.js process.

- Array of pending jobs, one "currently processing" slot
- Serial processing: one Claude Code session at a time (memory constraint: ~500 MB per session, VPS has 2.5 GB free)
- Job states: `queued` → `processing` → `done` | `failed`
- Timeout: kill Claude process after 5 minutes
- On process crash/restart: pending jobs are lost (acceptable — user resubmits)
- Optional future enhancement: persist queue to a JSON file on disk

### 4. Claude Code Invocation

**Command:**
```bash
claude --bare -p "<prompt>" \
  --allowedTools "Read,Write,Edit,Bash" \
  --max-turns 30 \
  --max-budget-usd 1.00 \
  --output-format json
```

**Authentication:** Uses the operator's Claude Code login credentials on the Relay VPS (no API key needed, no per-transcript cost).

**Working directory:** `/tmp/transcripts/<job_id>/`

**Input files (created by server before spawning Claude):**
- `raw.json` — the full fmt=json3 transcript data (as received from bookmarklet)
- `raw.txt` — plain text extracted from the raw data, split into paragraphs by timing gaps (same logic as current `to_paragraphs()`)
- `metadata.json` — `{ video_id, title, channel, url, transcript_type }`

**Prompt instructs Claude to:**
1. Read `raw.txt`
2. Format with proper punctuation, capitalization, paragraph breaks
3. Fix transcription errors (homophones, technical terms, names, acronyms)
4. Write result to `corrected.txt`
5. Report changes made

**Claude does NOT:**
- Touch timestamps (handled by alignment script)
- Create files in Relay (handled by server after Claude finishes)
- Run for more than 30 turns or $1.00

### 5. Timestamp Alignment Script

After Claude produces `corrected.txt`, the server runs the alignment logic.

**Options (in order of preference):**
1. **Port to TypeScript/Node.js** — runs natively in the lens-editor process, no Python dependency. The algorithm (SequenceMatcher-based word alignment) is straightforward to reimplement.
2. **Call existing Python script** — `create_corrected.py` from youtube-transcription-tool. Requires Python + the script on the Relay VPS.
3. **Port to Rust** — add to the relay-server crate. Overkill for this use case.

**Input:** `raw.json` + `corrected.txt`
**Output:** `corrected.json` (words with aligned timestamps) + final `.md` and `.timestamps.json`

### 6. Relay File Creation

After alignment produces the final files, the server creates them in Lens Relay:

- `Lens Edu/video_transcripts/{channel}-{title}.md` — formatted markdown with YAML frontmatter
- `Lens Edu/video_transcripts/{channel}-{title}.timestamps.json` — word-level timestamp array

**Creation method:** The lens-editor already proxies to the relay-server. It can either:
- Call the relay-server's MCP `create` tool via HTTP (requires adding `.json` support)
- Directly manipulate Y.Docs via the yjs library (lens-editor already has yjs as a dependency)

**Relay MCP change required:** The `create` tool currently validates `file_path.ends_with(".md")`. This must be relaxed to also allow `.json` files.

### 7. Install Page

**Location:** `lens-editor/public/add-video.html` (static, served by Vite/Hono)
**Production URL:** `editor.lensacademy.org/add-video` (or similar)

Simple page with:
- Drag-to-install bookmarklet link (dynamically sets `href` from the JS file)
- Step-by-step usage instructions
- Bookmarks bar visibility hint

## Data Flow Detail

### Transcript extraction (bookmarklet)

```
1. Bookmarklet reads page scripts for INNERTUBE_API_KEY, CLIENT_VERSION, VISITOR_DATA
2. For each video ID:
   POST https://www.youtube.com/youtubei/v1/player?key=<API_KEY>
   Body: { videoId, context: { client: { clientName: "WEB", clientVersion, visitorData } } }
   → Response includes captions.playerCaptionsTracklistRenderer.captionTracks[]
3. Select English track (or first available)
   GET <track.baseUrl>&fmt=json3
   → Response: { events: [{ tStartMs, dDurationMs, segs: [{ utf8, tOffsetMs }] }] }
4. Package: { video_id, title, channel, url, transcript_type, transcript_raw }
```

### Transcript processing (server)

```
1. Receive payload, create job, save to /tmp/transcripts/<job_id>/
2. Immediately create placeholder .md in Relay:
   Lens Edu/video_transcripts/{channel}-{title}.md with:
     ---
     title: "Video Title"
     channel: "Channel Name"
     url: "https://www.youtube.com/watch?v=..."
     video_id: "..."
     status: "processing"
     queued_at: "2026-04-02T18:30:00Z"
     ---

     This transcript is being processed. Please check back shortly.
3. Extract plain text from raw.json → raw.txt (paragraphs split on 2s+ timing gaps)
4. Spawn claude --bare -p "<formatting prompt>" in /tmp/transcripts/<job_id>/
5. Claude reads raw.txt, writes corrected.txt
6. Run timestamp alignment: raw.json + corrected.txt → corrected.json
7. Export: corrected.json → final .md content + .timestamps.json
8. Replace placeholder .md in Relay with final formatted transcript
   (remove status and queued_at from frontmatter)
9. Create .timestamps.json in Relay
10. Clean up /tmp/transcripts/<job_id>/
11. Mark job done
```

On failure, the placeholder is updated to:
```markdown
---
title: "Video Title"
channel: "Channel Name"
url: "https://www.youtube.com/watch?v=..."
video_id: "..."
status: "failed"
queued_at: "2026-04-02T18:30:00Z"
failed_at: "2026-04-02T18:35:00Z"
---

Transcript processing failed. You can resubmit this video from the
[Add Video](/add-video) page.
```

## Output Formats

**Markdown** (`{channel}-{title}.md`):
```markdown
---
title: "AI Self Improvement - Computerphile"
channel: "Computerphile"
url: "https://www.youtube.com/watch?v=5qfIgCiYlfY"
video_id: "5qfIgCiYlfY"
---

The stamp collecting machine we talked about last time is a physical
impossibility, but it has a really interesting property...
```

**Timestamps** (`{channel}-{title}.timestamps.json`):
```json
[
  {"text": "The", "start": "0:00.08"},
  {"text": "stamp", "start": "0:00.16"}
]
```

Same formats as the current youtube-transcription-tool output.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Video has no captions | Bookmarklet shows error per-video, others continue |
| YouTube API changes | Bookmarklet fails visibly; update bookmarklet JS |
| Claude fails/times out | Job marked "failed" with error; user retries |
| Claude produces bad formatting | Acceptable — can fix later in Relay editor |
| VPS out of memory | Claude process OOM-killed; job fails; user retries |
| Server restarts mid-queue | Pending jobs lost; user resubmits |
| Duplicate video submitted | Server checks if file already exists in Relay; if it has `status: "processing"`, tells user it's already queued; if it has no status (completed), warns that it already exists |

## Security

- Bookmarklet runs only on youtube.com (hostname check)
- Server endpoint requires authentication (same as lens-editor)
- Claude Code runs with limited tools (Read, Write, Edit, Bash only)
- Claude budget capped at $1.00 per transcript
- Claude process killed after 5-minute timeout
- Temp files cleaned up after processing

## Dependencies

**Browser (bookmarklet):**
- None. Pure vanilla JS, no external libraries.

**Relay VPS:**
- Claude Code CLI (npm install, logged in with operator credentials)
- Node.js (already present for lens-editor)
- Python 3 (for timestamp alignment, unless ported to TS)
- youtube-transcription-tool's `create_corrected.py` + `export_final.py` (or TS port)

## What's NOT in scope

- Automatic re-processing when Claude Code is updated
- Webhook/callback when processing completes (polling is sufficient)
- User accounts or per-user job history
- Video download or audio processing
- Translation of non-English transcripts
- Editing transcripts in-browser before sending
