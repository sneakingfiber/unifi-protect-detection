# UniFi Protect Detections UI

Local Node.js service + web UI to query detection events from a UniFi Protect NVR.

## What you can select in UI
- NVR IP / host
- Protect username/password
- Event types
- Camera(s)
- Time interval (from / to)
- Timezone (default: Europe/Rome)
- Max results
- Output folder for saving images

## Features
- Connect to UniFi Protect using `unifi-protect` SDK
- Search events by filters
- Preview snapshots in table
- Save returned detection images to disk
  - prefers event thumbnail
  - fallback to camera snapshot

## Run
```bash
npm install
npm start
```
Open: `http://localhost:8899`

## API routes
- `GET /api/health`
- `POST /api/cameras`
- `POST /api/detections`
- `GET /api/snapshot-proxy?d=...`
- `POST /api/save-images`

## Notes
- Designed for local network usage with your NVR.
- Credentials are only kept in process memory (not written by this app).
