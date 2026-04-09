# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start

```bash
npm install
npm run dev          # watches server.js for changes; listens on PORT (default 8899)
npm start            # production start
npm run health       # quick healthcheck probe
```

Open `http://localhost:8899` in browser. See `TESTING.md` for manual QA checklist.

## Architecture Overview

**Two-file single-page app** (no build step, no framework dependencies):

- **`server.js`** (347 lines) — Express backend handles authentication, detections queries, image proxying, and save-to-disk operations
- **`public/index.html`** (560+ lines) — Entire frontend (HTML + inline CSS + inline JS) in one file

Both files use plain CommonJS (no TypeScript, no module bundler).

## Key Concepts

### Session & Authentication

- **No persistent login state.** Credentials (host, username, password) are sent in the body of *every* API request from the browser.
- **In-memory sessions Map** (`server.js` line 13): keyed by `"${host}::${username}"`, stores a `ProtectApi` SDK instance. Each entry caches the authenticated connection.
- **10-minute re-login threshold**: if a session hasn't logged in for 10+ minutes, the next API call forces a fresh `api.login()`. This prevents stale credentials.
- **Session cleanup**: sessions idle for 30+ minutes are evicted from the Map (every 5 min check) to prevent memory leaks from accumulating unused entries.
- **Security trade-off**: credentials travel in HTTP request bodies (not HTTPS on localhost). Acceptable for local LAN use; document as a known limitation if exposing remotely.

### Event Fetching & Filtering

1. Frontend sends POST to `/api/detections` with: `host`, `username`, `password`, `startTime`, `endTime`, `cameraIds[]`, `eventTypes[]`, `limit`.
2. Client converts `datetime-local` input + user-selected timezone → Unix milliseconds before sending (see `localInputToUtcMs()` in `index.html`).
3. Server builds a `URLSearchParams` for the Protect API at `/proxy/protect/api/events` and applies filters.
4. **Fallback broad query**: if filtered results are empty and filters were active, a second query without camera/type params is made and the same local filter re-applied. This works around the Protect API sometimes not honoring query filters.
5. Events are normalized to a common shape (`normalizeEvent`) and returned with camera name mapping and filter diagnostics.

### Image Proxying

- **Event thumbnail**: `GET /api/event-thumbnail-proxy?d=<url-encoded-json>` fetches from `/proxy/protect/api/events/{eventId}/thumbnail`.
- **Camera snapshot fallback**: `GET /api/snapshot-proxy?d=<url-encoded-json>` fetches live snapshot from camera.
- Both embed credentials in URL query params (encoded as JSON) — credentials visible in browser network tab and server logs. Security trade-off noted above.

### Save-to-Disk

- `POST /api/save-images` accepts an array of events and an output directory.
- Tries event thumbnail first; falls back to live camera snapshot if unavailable.
- Files named: `<ISO-timestamp>__<cameraId>__<eventType>__<eventId>.jpg`.
- Validates `limit` (1–500), sanitizes filenames via `safeName()`, but does NOT restrict `outputDir` path — any writable directory is allowed (by design for flexibility; document as a risk if exposing beyond localhost).

## Critical Files & Patterns

| File | Purpose | Key functions / sections |
|------|---------|-------------------------|
| `server.js` | Express backend | `getSession()` (auth), `fetchEvents()` (API calls), `toUnixMillis()` (timestamp conversion), routes: `/api/cameras`, `/api/detections`, `/api/event-thumbnail-proxy`, `/api/snapshot-proxy`, `/api/save-images` |
| `public/index.html` | Entire frontend | `localInputToUtcMs()` (timezone fix), `populateTimezones()` (dynamic TZ dropdown), `creds()` (read form inputs), `post()` (fetch wrapper), event row rendering loop in `search.onclick` |

## Known Issues & Trade-offs

1. **Timezone mismatch (fixed in recent commit)**: `datetime-local` inputs were parsed in server's system TZ instead of user-selected TZ. Fixed by converting on client to UTC milliseconds before sending.

2. **Credentials in URL params**: image proxy routes expose credentials in query strings. For local-only deployments this is acceptable; document if planning remote exposure.

3. **No pagination**: max 500 results. No way to fetch next batch of events. Consider adding if needed.

4. **Event metadata loss**: `normalizeEvent()` only keeps essential fields; any Protect-specific metadata (zones, license plates, etc.) is dropped and unavailable to frontend.

5. **Select / deselect UX**: as of recent commit, results table has per-row checkboxes for selective save. Previously saved all results.

## Common Edits

- **Add event type filter**: check `typeOptions` array in `index.html` and the event type logic in `server.js` `fetchEvents()`.
- **Change default timezone**: edit `preferred` array in `populateTimezones()` function or set `'Europe/Rome'` fallback.
- **Adjust session TTL**: edit `SESSION_TTL_MS` constant in `server.js` line 15.
- **Change snapshot width**: the frontend hardcodes `width: 640` in the proxy request; server defaults to 1280 for save. Both are configurable.
- **Add new API route**: follow the pattern of `/api/cameras` or `/api/detections` — always require `host`, `username`, `password` in body, use `getSession()`, log with `log()`.

## Testing & Deployment

See `TESTING.md` for manual QA checklist, common failure modes, and deploy readiness criteria. No automated tests exist; all validation is manual + browser/server log inspection.

## Environment

- `PORT` (default 8899) — sets the Express listen port. Can be overridden via `.env` or `PORT=9000 npm start`.
- `.env.example` documents the only env var; copy to `.env` if needed.
