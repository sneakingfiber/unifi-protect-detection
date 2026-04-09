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

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function keyOf({ host, username }) {
  return `${host}::${username}`;
}

async function getSession({ host, username, password, force = false }) {
  log('[session] request', { host, username, force });
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
    log('[session] login start', { host, username });
    const ok = await entry.api.login(host, username, password);
    if (!ok) {
      log('[session] login failed', { host, username });
      throw new Error('Protect login failed. Check host/username/password.');
    }
    const bs = await entry.api.getBootstrap();
    log('[session] login ok + bootstrap', { host, username, bootstrap: !!bs, cameras: entry.api.bootstrap?.cameras?.length || 0 });
    entry.lastLogin = Date.now();
  }

  return entry.api;
}

function toUnixMillis(input) {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
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

function buildProtectUrl(host, endpointWithSlash) {
  return `https://${host}${endpointWithSlash}`;
}

async function fetchEvents(api, host, params) {
  const url = buildProtectUrl(host, `/proxy/protect/api/events?${params.toString()}`);
  log('[api/detections] request', {
    host,
    hasStart: params.has('start'),
    hasEnd: params.has('end'),
    cameraFilters: params.getAll('camera').length,
    typeFilters: params.getAll('types').length,
    limit: params.get('limit'),
  });
  const events = await retrieveJson(api, url);
  return Array.isArray(events) ? events : [];
}

async function retrieveJson(api, url) {
  const result = await api.retrieve(url);
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && result.body && typeof result.statusCode === 'number') {
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`Protect API HTTP ${result.statusCode}`);
    }
    const txt = await result.body.text();
    if (!txt) return [];
    try {
      return JSON.parse(txt);
    } catch {
      throw new Error('Protect API returned non-JSON body');
    }
  }
  return result || [];
}

async function fetchEventThumbnail(api, host, eventId) {
  const response = await api.retrieve(buildProtectUrl(host, `/proxy/protect/api/events/${eventId}/thumbnail`), { method: 'GET' });
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
    log('[api/cameras] incoming', { host, username });
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

    log('[api/cameras] result', { count: cameras.length });
    res.json({ cameras });
  } catch (e) {
    log('[api/cameras] error', e.message);
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

    log('[api/detections] incoming', {
      host,
      username,
      startTime,
      endTime,
      cameraIdsCount: cameraIds.length,
      eventTypes,
      limit,
    });

    const api = await getSession({ host, username, password });

    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const includeTypes = eventTypes.filter(Boolean);
    const includeCameras = cameraIds.filter(Boolean);

    const filteredParams = new URLSearchParams();
    filteredParams.set('limit', String(safeLimit));

    const start = toUnixMillis(startTime);
    const end = toUnixMillis(endTime);
    if (start) filteredParams.set('start', String(start));
    if (end) filteredParams.set('end', String(end));

    for (const c of includeCameras) filteredParams.append('camera', c);
    for (const t of includeTypes) filteredParams.append('types', t);

    const filteredEvents = await fetchEvents(api, host, filteredParams);
    const localFilteredEvents = filteredEvents.filter(ev => {
      const matchesCamera = !includeCameras.length || includeCameras.includes(ev?.camera);
      if (!matchesCamera) return false;
      if (!includeTypes.length) return true;
      const tags = [ev?.type, ...(ev?.smartDetectTypes || [])].filter(Boolean);
      return includeTypes.some(t => tags.includes(t));
    });

    let finalEvents = localFilteredEvents;
    let broadEvents = [];

    if (localFilteredEvents.length === 0 && (includeTypes.length || includeCameras.length)) {
      const broadParams = new URLSearchParams();
      broadParams.set('limit', String(safeLimit));
      if (start) broadParams.set('start', String(start));
      if (end) broadParams.set('end', String(end));

      broadEvents = await fetchEvents(api, host, broadParams);
      finalEvents = broadEvents.filter(ev => {
        const matchesCamera = !includeCameras.length || includeCameras.includes(ev?.camera);
        if (!matchesCamera) return false;
        if (!includeTypes.length) return true;
        const tags = [ev?.type, ...(ev?.smartDetectTypes || [])].filter(Boolean);
        return includeTypes.some(t => tags.includes(t));
      });

      log('[api/detections] fallback-broad-query', {
        filteredRawCount: filteredEvents.length,
        broadCount: broadEvents.length,
        afterLocalFilter: finalEvents.length,
      });
    }

    const normalized = finalEvents.map(normalizeEvent);
    const cameraMap = Object.fromEntries((api.bootstrap?.cameras || []).map(c => [c.id, c.name || c.id]));
    const diagnostics = {
      broadCount: broadEvents.length,
      filterStage: {
        filteredQueryRawCount: filteredEvents.length,
        filteredQueryLocalCount: localFilteredEvents.length,
        broadQueryRawCount: broadEvents.length,
        finalCount: normalized.length,
      },
    };

    log('[api/detections] result', diagnostics.filterStage);
    res.json({ count: normalized.length, events: normalized, cameraMap, diagnostics });
  } catch (e) {
    const errorMessage = e?.message || 'Unknown detections error';
    log('[api/detections] error', { message: errorMessage, name: e?.name });
    res.status(500).json({
      error: 'Failed to fetch detections from UniFi Protect. Verify filters/time range and server reachability.',
      details: errorMessage,
    });
  }
});

app.get('/api/event-thumbnail-proxy', async (req, res) => {
  try {
    const raw = req.query.d;
    if (!raw) return res.status(400).send('missing payload');
    const body = JSON.parse(decodeURIComponent(raw));
    const { host, username, password, eventId } = body;
    if (!eventId) return res.status(400).send('missing eventId');

    const api = await getSession({ host, username, password });
    const img = await fetchEventThumbnail(api, host, eventId);
    if (!img) return res.status(404).send('event thumbnail unavailable');

    res.setHeader('Content-Type', 'image/jpeg');
    res.send(Buffer.from(img));
  } catch {
    res.status(500).send('event thumbnail error');
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
          img = await fetchEventThumbnail(api, host, eventId);
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
