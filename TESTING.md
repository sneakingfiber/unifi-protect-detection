# TESTING (QA + Deploy Readiness)

Quick local checks before deploy.

## 0) Start app
1. `cp .env.example .env` (if needed)
2. `npm install`
3. `npm run dev` (or `npm start`)
4. Open `http://localhost:8899`

Expected: page loads, no server crash.

## 1) Login + Cameras
1. Fill **Host / Username / Password**.
2. Click **Load Cameras**.

Expected: camera list appears with real names.

If fails:
- Wrong host or creds → check Protect web login first.
- TLS / connectivity issue → from same machine try `https://<host>` in browser.

## 2) Broad Search (sanity)
1. Keep no camera filter (all cameras).
2. Keep event types broad (or empty/all).
3. Use a known busy window (last 24h).
4. Set limit to 100-200.
5. Search.

Expected: non-zero results, table rows render, previews load.

## 3) Filtered Search (precision)
1. Pick 1-2 cameras.
2. Select 1 specific type (e.g. `person`, `vehicle`, `motion`).
3. Narrow time range (e.g. 1-2h where activity is known).
4. Search again.

Expected: fewer results than broad search and filters match.

## 4) Save Images
1. Set output folder (absolute path recommended).
2. Select some returned events.
3. Click save/export.

Expected: files written with timestamp/camera/type/event in filename.

## Common failures + quick diagnosis

### HTTP 499 from Protect
Usually upstream closed request (session timeout/network/proxy interruption).

Quick checks:
- Retry once after **Load Cameras** (forces fresh login).
- Check server logs around `[session] login` and `[api/detections] request`.
- Verify NVR is reachable and not overloaded.
- Reduce search window and limit (large queries are more fragile).

### `0 results`
Usually filters/time range too narrow, timezone mismatch, or wrong event type names.

Quick checks:
- Run broad search first (all cameras, all types, last 24h).
- Confirm timezone and time range include known detections.
- Remove type filter, then re-add one filter at a time.
- Confirm selected cameras actually had activity.

## Ready-to-deploy checklist
- [ ] App starts cleanly on target machine
- [ ] Login + camera load works
- [ ] Broad search returns data
- [ ] Filtered search behaves correctly
- [ ] Save images writes files to expected directory
- [ ] No repeated 499 or 5xx errors in logs during above tests
