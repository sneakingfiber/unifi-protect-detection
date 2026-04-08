require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { ProtectApi } = require('unifi-protect');

const app = express();
const PORT = process.env.PORT || 8899;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function keyOf({ host, username }) {
  return `${host}::${username}`;
}

async function getSession({ host, username, password, force = false }) {
  const key = keyOf({ host, username });
  let entry = sessions.get(key);

  if (!entry) {
    const api = new ProtectApi();
    entry = { api, host, username, password, lastLogin: 0 };
    sessions.set(key, entry);
  } else {
    entry.password = password;
  }

  const needsLogin = force || !entry.lastLogin || (Date.now() - entry.lastLogin > 10 * 60 * 1000);
  if (needsLogin) {
    const ok = await entry.api.login(host, username, password);
    if (!ok) throw new Error('Protect login failed. Check host/username/password.');
    await entry.api.getBootstrap();
    entry.lastLogin = Date.now();
  }

  return entry.api;
}

function toUnixSeconds(input) {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

function normalizeEvent(ev) {
  const score = ev?.score ?? ev?.smartDetectScore ?? null;
  const types = ev?.smartDetectTypes || [];
  return {
    id: ev?.id,
    type: ev?.type,
    start: ev?.start,
    end: ev?.end,
    camera: ev?.camera,
    smartDetectTypes: types,
    score,
    heatmap: !!ev?.heatmap,
    metadata: ev?.metadata || {},
  };
}

function safeName(v) {
  return String(v || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

async function fetchEventThumbnail(api, eventId) {
  const response = await api.retrieve(`/proxy/protect/api/events/${eventId}/thumbnail`, { method: 'GET' });
  if (!response || !response.body) return null;
  try {
    return Buffer.from(await response.body.arrayBuffer());
  } catch {
    return null;
  }
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, service: 'unifi-protect-detections' });
});

app.post('/api/cameras', async (req, res) => {
  try {
    const { host, username, password } = req.body;
    if (!host || !username || !password) {
      return res.status(400).json({ error: 'host, username, password are required' });
    }

    const api = await getSession({ host, username, password, force: true });
    const cameras = (api.bootstrap?.cameras || []).map(c => ({
      id: c.id,
      name: c.name,
      model: c.marketName,
      isRecording: c.isRecording,
    }));

    res.json({ cameras });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/detections', async (req, res) => {
  try {
    const {
      host, username, password,
      startTime, endTime,
      cameraIds = [],
      eventTypes = [],
      limit = 100,
    } = req.body;

    if (!host || !username || !password) {
      return res.status(400).json({ error: 'host, username, password are required' });
    }

    const api = await getSession({ host, username, password });

    const params = new URLSearchParams();
    params.set('limit', String(Math.min(Number(limit) || 100, 500)));

    const start = toUnixSeconds(startTime);
    const end = toUnixSeconds(endTime);
    if (start) params.set('start', String(start));
    if (end) params.set('end', String(end));

    for (const c of cameraIds.filter(Boolean)) params.append('camera', c);

    const includeTypes = eventTypes.filter(Boolean);
    for (const t of includeTypes) params.append('types', t);

    const events = await api.retrieve(`/proxy/protect/api/events?${params.toString()}`);

    const normalized = (Array.isArray(events) ? events : [])
      .filter(ev => {
        if (!includeTypes.length) return true;
        const tags = [ev?.type, ...(ev?.smartDetectTypes || [])].filter(Boolean);
        return includeTypes.some(t => tags.includes(t));
      })
      .map(normalizeEvent);

    const cameraMap = Object.fromEntries((api.bootstrap?.cameras || []).map(c => [c.id, c.name || c.id]));

    res.json({ count: normalized.length, events: normalized, cameraMap });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/snapshot-proxy', async (req, res) => {
  try {
    const raw = req.query.d;
    if (!raw) return res.status(400).send('missing payload');
    const body = JSON.parse(decodeURIComponent(raw));
    const { host, username, password, cameraId, width = 640 } = body;
    const api = await getSession({ host, username, password });
    const cam = (api.bootstrap?.cameras || []).find(c => c.id === cameraId);
    if (!cam) return res.status(404).send('camera not found');
    const snap = await api.getSnapshot(cam, { width });
    if (!snap) return res.status(404).send('snapshot unavailable');
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(Buffer.from(snap));
  } catch {
    res.status(500).send('snapshot error');
  }
});

app.post('/api/save-images', async (req, res) => {
  try {
    const {
      host, username, password,
      outputDir,
      events = [],
      width = 1280,
      useEventThumbnail = true,
    } = req.body;

    if (!host || !username || !password) return res.status(400).json({ error: 'host, username, password are required' });
    if (!outputDir) return res.status(400).json({ error: 'outputDir is required' });

    const api = await getSession({ host, username, password });
    await fs.mkdir(outputDir, { recursive: true });

    const cams = new Map((api.bootstrap?.cameras || []).map(c => [c.id, c]));

    const saved = [];
    const failed = [];

    for (const ev of events) {
      try {
        const cameraId = ev.camera;
        const eventId = ev.id;
        const eventType = (ev.smartDetectTypes?.[0] || ev.type || 'event');
        const ts = ev.start ? new Date(ev.start).toISOString().replace(/[:.]/g, '-') : new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${ts}__${safeName(cameraId)}__${safeName(eventType)}__${safeName(eventId)}.jpg`;
        const full = path.join(outputDir, filename);

        let img = null;
        if (useEventThumbnail && eventId) {
          img = await fetchEventThumbnail(api, eventId);
        }

        if (!img) {
          const cam = cams.get(cameraId);
          if (!cam) throw new Error('camera not found');
          img = await api.getSnapshot(cam, { width });
        }

        if (!img) throw new Error('no image returned');
        await fs.writeFile(full, Buffer.from(img));
        saved.push({ eventId, cameraId, path: full });
      } catch (err) {
        failed.push({ eventId: ev?.id, cameraId: ev?.camera, error: err.message });
      }
    }

    res.json({ ok: true, savedCount: saved.length, failedCount: failed.length, saved, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`UniFi Protect detections UI: http://0.0.0.0:${PORT}`);
});
