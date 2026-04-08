require('dotenv').config();
const express = require('express');
const path = require('path');
const { ProtectApi } = require('unifi-protect');

const app = express();
const PORT = process.env.PORT || 8899;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function keyOf({ host, username }) {
  return `${host}::${username}`;
}

async function getSession({ host, username, password }) {
  const key = keyOf({ host, username });
  let entry = sessions.get(key);

  if (!entry) {
    const api = new ProtectApi();
    entry = { api, host, username, password, lastLogin: 0 };
    sessions.set(key, entry);
  } else {
    entry.password = password;
  }

  const needsLogin = !entry.lastLogin || (Date.now() - entry.lastLogin > 10 * 60 * 1000);
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

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, service: 'unifi-protect-detections' });
});

app.post('/api/cameras', async (req, res) => {
  try {
    const { host, username, password } = req.body;
    if (!host || !username || !password) {
      return res.status(400).json({ error: 'host, username, password are required' });
    }

    const api = await getSession({ host, username, password });
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
    const { host, username, password, startTime, endTime, cameraIds = [], eventTypes = [], limit = 100 } = req.body;
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

    if (cameraIds.length) {
      for (const c of cameraIds) params.append('camera', c);
    }

    const includeTypes = eventTypes.filter(Boolean);
    if (includeTypes.length) {
      for (const t of includeTypes) params.append('types', t);
    }

    const events = await api.retrieve(`/proxy/protect/api/events?${params.toString()}`);
    const normalized = (Array.isArray(events) ? events : [])
      .filter(ev => {
        if (!includeTypes.length) return true;
        const tags = [ev?.type, ...(ev?.smartDetectTypes || [])].filter(Boolean);
        return includeTypes.some(t => tags.includes(t));
      })
      .map(normalizeEvent);

    res.json({ count: normalized.length, events: normalized });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/snapshot', async (req, res) => {
  try {
    const { host, username, password, cameraId, width = 1280 } = req.body;
    if (!host || !username || !password || !cameraId) {
      return res.status(400).json({ error: 'host, username, password, cameraId are required' });
    }

    const api = await getSession({ host, username, password });
    const cam = (api.bootstrap?.cameras || []).find(c => c.id === cameraId);
    if (!cam) return res.status(404).json({ error: 'camera not found' });

    const snap = await api.getSnapshot(cam, { width });
    if (!snap) return res.status(404).json({ error: 'snapshot unavailable' });

    res.setHeader('Content-Type', 'image/jpeg');
    res.send(Buffer.from(snap));
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
  } catch (e) {
    res.status(500).send('snapshot error');
  }
});

app.listen(PORT, () => {
  console.log(`UniFi Protect detections UI: http://0.0.0.0:${PORT}`);
});
