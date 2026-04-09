# UniFi Protect Detection Explorer

A local **Node.js service + web UI** to query detection events from a UniFi Protect NVR, preview event images, and save them to disk.

Built for operators who need fast filtering by camera, event type, and time window — with practical diagnostics for real-world troubleshooting.

---

## What it does

- Connects to a UniFi Protect NVR with local credentials
- Loads available cameras from the controller
- Fetches events in a selected time interval
- Filters by:
  - camera(s)
  - event types
  - max results
- Shows preview images per event
  - **Primary:** event thumbnail (historical event frame)
  - **Fallback:** live camera snapshot
- Saves returned detection images to a local folder
- Exposes backend diagnostics in UI for easier debugging

---

## UI Highlights

- UniFi-inspired visual style
- Default time range: **last 1 hour**
- Timezone selector (default: **Europe/Rome**)
- Loading states for connect/search/save
- Filter summary and no-results guidance
- Technical diagnostics panel

---

## Tech Stack

- Node.js + Express
- [`unifi-protect`](https://www.npmjs.com/package/unifi-protect) SDK
- Plain HTML/CSS/JS frontend (no framework)

---

## Project Structure

```text
unifi-protect-detections/
├── public/
│   └── index.html           # Web UI
├── server.js                # API service
├── TESTING.md               # QA / deploy checklist
├── package.json
└── README.md
```

---

## Quick Start

```bash
npm install
npm start
```

Open the UI:

- Local: `http://127.0.0.1:8899`
- LAN: `http://<server-ip>:8899`

Health check:

```bash
curl http://127.0.0.1:8899/api/health
```

---

## Usage Flow

1. Enter NVR host/IP + local Protect username/password
2. Click **Connect & Load Cameras**
3. Select time range, cameras, event types
4. Click **Search Detections**
5. (Optional) Set output folder and click **Save Returned Images to Disk**

### Save Images Folder Examples

- Linux: `/home/your-user/unifi-detections`
- macOS: `/Users/your-user/Desktop/unifi-detections`

The service writes with permissions of the user running `npm start`.

---

## API Endpoints

- `GET /api/health`
- `POST /api/cameras`
- `POST /api/detections`
- `GET /api/event-thumbnail-proxy?d=...`
- `GET /api/snapshot-proxy?d=...`
- `POST /api/save-images`

---

## Important Notes

### 1) Use local Protect users
For best compatibility, use a **local UniFi Protect account** (not cloud-SSO dependent flows).

### 2) Time filter semantics
Event time filtering uses timestamps aligned to Protect expectations; this was fixed to avoid empty-result false negatives.

### 3) Event image correctness
Event previews are fetched from event thumbnail endpoints. If unavailable, snapshot fallback is used.

### 4) Remote access
Recommended approach is VPN (WireGuard/Tailscale) to reach NVR LAN IPs securely.

---

## Troubleshooting

### Login issues (e.g. API 499)
- verify host/IP is the actual Protect controller
- verify local user credentials
- verify account permissions (view/admin as needed)

### No detections returned
- widen range to last 24h / 7d
- remove camera/type filters and retry
- inspect diagnostics panel for `filteredQueryRawCount` and `broadQueryRawCount`

### Images not saved
- confirm output path is absolute
- confirm write permissions for process user
- check backend response `failed[]` list

See also: `TESTING.md`.

---

## Development Scripts

```bash
npm start      # run service
npm run dev    # run with node --watch
npm run health # quick local health probe
```

---

## Security

- Keep credentials private
- Prefer running behind VPN / trusted LAN
- Do not expose service publicly without auth proxy

---

## License

For private/internal use unless you define a project license.
