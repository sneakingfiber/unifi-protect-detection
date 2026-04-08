# UniFi Protect Detections UI

Local Node.js service + web UI to query detection events from a UniFi Protect NVR.

## Features
- Login to Protect (host, username, password) from UI
- Load cameras from NVR
- Filter events by:
  - event types (motion, person, vehicle, animal, package, etc.)
  - camera(s)
  - time interval (from/to)
  - limit
- View detection list
- Show camera snapshots alongside results

## Run

```bash
npm install
npm start
```

Open: `http://localhost:8899`

## API routes
- `POST /api/cameras`
- `POST /api/detections`
- `POST /api/snapshot`
- `GET /api/snapshot-proxy?d=...`

## Notes
- Uses `unifi-protect` Node SDK.
- This project is for local network usage with your own NVR.
- Credentials are kept in process memory only (not persisted to disk by this app).
