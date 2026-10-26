import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const hasGemini = Boolean(process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('PASTE_'));
const hasYoutube = Boolean(process.env.YOUTUBE_API_KEY && !process.env.YOUTUBE_API_KEY.includes('PASTE_'));
const hasDeviceToken = Boolean(process.env.DEVICE_TOKEN && process.env.DEVICE_TOKEN.length >= 32 && !process.env.DEVICE_TOKEN.includes('REPLACE_'));
const COMMAND_TTL_MS = 120_000;
const MAX_PENDING_COMMANDS = 20;
// Starter single-device queue. Commands are intentionally short-lived and are not persisted across restarts.
const device = { queue: [], inFlight: null, lastSeen: 0 };

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render terminates HTTPS at its proxy.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function deviceTokenAuth(req, res, next) {
  if (!hasDeviceToken) return res.status(503).json({ error: 'DEVICE_TOKEN is not configured on the backend.' });
  if (!safeEqual(req.get('X-Device-Token'), process.env.DEVICE_TOKEN)) return res.status(401).json({ error: 'Device authentication failed.' });
  next();
}

// Device polling uses its own long random token. All browser routes still use Basic Auth.
app.use((req, res, next) => {
  if (req.path === '/api/device/poll' || req.path === '/api/device/ack') return next();
  if (!process.env.APP_USERNAME || !process.env.APP_PASSWORD) return res.status(503).send('Set APP_USERNAME and APP_PASSWORD in the backend environment.');
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch {}
    const sep = decoded.indexOf(':');
    if (sep >= 0 && safeEqual(decoded.slice(0, sep), process.env.APP_USERNAME) && safeEqual(decoded.slice(sep + 1), process.env.APP_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="HomeAI Pro"');
  return res.status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, '../web'), { extensions: ['html'] }));
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  geminiConfigured: hasGemini,
  youtubeConfigured: hasYoutube,
  deviceTokenConfigured: hasDeviceToken,
  controllerOnline: Date.now() - device.lastSeen < 20_000,
  commandTransport: 'https-polling'
}));

const applianceMap = {
  'living room light': 0, 'first light': 0, 'light 1': 0,
  'fan': 1, 'second light': 2, 'light 2': 2,
  'fourth appliance': 3, 'appliance 4': 3
};
function extractDevice(text) {
  const s = text.toLowerCase();
  return Object.keys(applianceMap).sort((a, b) => b.length - a.length).find(k => s.includes(k));
}
function parseSafeDeviceCommand(text) {
  const s = text.toLowerCase();
  if (/(turn|switch|shut).*(everything|all).*(off)|\ball off\b|saare.*(band|off)|sab.*(band|off)/.test(s)) return { action: 'alloff' };
  const name = extractDevice(s);
  if (!name) return null;
  const on = /\b(on|start|enable)\b|chala do|jala do/.test(s);
  const off = /\b(off|stop|disable)\b|band kar|bujha do/.test(s);
  if (on === off) return null;
  return { action: 'relay', id: applianceMap[name], state: on };
}
function enqueueDeviceCommand(command) {
  if (!hasDeviceToken) throw new Error('Device control is not configured. Set DEVICE_TOKEN on the cloud backend and ESP8266.');
  if (device.queue.length + (device.inFlight ? 1 : 0) >= MAX_PENDING_COMMANDS) throw new Error('Command queue is full. Check that the ESP8266 is online.');
  const item = { commandId: crypto.randomUUID(), command, createdAt: Date.now(), expiresAt: Date.now() + COMMAND_TTL_MS };
  device.queue.push(item);
  return item;
}
function cleanupExpired() {
  const now = Date.now();
  device.queue = device.queue.filter(item => item.expiresAt > now);
  if (device.inFlight && device.inFlight.expiresAt <= now) device.inFlight = null;
}

app.post('/api/device', (req, res) => {
  const text = String(req.body?.command || '').slice(0, 300);
  const command = parseSafeDeviceCommand(text);
  if (!command) return res.status(400).json({ error: 'I could not match a safe, specific appliance command.' });
  try {
    const item = enqueueDeviceCommand(command);
    return res.json({ ok: true, queued: true, commandId: item.commandId, command, message: 'Command queued for the ESP8266. It will expire after two minutes if not delivered.' });
  } catch (e) { return res.status(503).json({ error: e.message }); }
});

// ESP8266 calls this endpoint every few seconds using X-Device-Token over HTTPS.
app.get('/api/device/poll', deviceTokenAuth, (req, res) => {
  device.lastSeen = Date.now();
  cleanupExpired();
  if (!device.inFlight && device.queue.length) device.inFlight = device.queue.shift();
  if (!device.inFlight) return res.status(200).json({ ok: true, command: null });
  return res.json({ ok: true, commandId: device.inFlight.commandId, command: device.inFlight.command });
});

app.post('/api/device/ack', deviceTokenAuth, (req, res) => {
  device.lastSeen = Date.now();
  const commandId = String(req.body?.commandId || '');
  if (!device.inFlight || !commandId || commandId !== device.inFlight.commandId) return res.status(409).json({ error: 'No matching pending command to acknowledge.' });
  device.inFlight = null;
  res.json({ ok: true, acknowledged: true });
});

app.post('/api/music-search', async (req, res) => {
  const query = String(req.body?.query || '').trim().slice(0, 160);
  if (!query) return res.status(400).json({ error: 'Enter a song or music mood.' });
  if (!hasYoutube) return res.status(503).json({ error: 'YouTube search is not configured. Add YOUTUBE_API_KEY to the backend environment.' });
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.search = new URLSearchParams({ part: 'snippet', q: query, type: 'video', videoCategoryId: '10', maxResults: '8', safeSearch: 'moderate', key: process.env.YOUTUBE_API_KEY }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const data = await response.json();
    if (!response.ok) return res.status(502).json({ error: data?.error?.message || 'YouTube search failed.' });
    res.json({ items: (data.items || []).filter(x => x.id?.videoId).map(x => ({ id: x.id.videoId, title: x.snippet?.title || 'YouTube video', channel: x.snippet?.channelTitle || '' })) });
  } catch { res.status(502).json({ error: 'Could not reach YouTube search service.' }); }
});

app.post('/api/chat', async (req, res) => {
  if (!hasGemini) return res.status(503).json({ error: 'Gemini is not configured. Add GEMINI_API_KEY to the backend environment.' });
  const message = String(req.body?.message || '').trim().slice(0, 2000);
  const language = req.body?.language === 'hinglish' ? 'Hinglish' : 'English';
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-10).map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text || '').slice(0, 1200) }] })) : [];
  if (!message) return res.status(400).json({ error: 'Message is empty.' });
  const deviceCommand = parseSafeDeviceCommand(message);
  if (deviceCommand) {
    try {
      enqueueDeviceCommand(deviceCommand);
      const reply = language === 'Hinglish' ? 'Command queue kar diya hai. Device online hoga to execute karega.' : 'I queued that command. It will run when the controller receives it.';
      return res.json({ reply, action: { type: 'device', ...deviceCommand } });
    } catch (e) {
      return res.status(503).json({ reply: language === 'Hinglish' ? 'Controller abhi ready nahi hai.' : 'The controller is not ready right now.', error: e.message });
    }
  }
  const system = `You are HomeAI, a warm, natural personal voice assistant. Reply in ${language}. If Hinglish, use casual Roman-script Hindi mixed with English, not Devanagari. Keep spoken replies concise and friendly. You can discuss music and smart homes, but do not claim you played music or controlled hardware unless the app reports that action. If the user asks to play a named song, music by mood/genre, or trending music, respond with exactly one line beginning MUSIC_SEARCH: followed by a useful YouTube search query, then optionally a short friendly sentence on the next line. Examples: MUSIC_SEARCH: Kesariya official song; MUSIC_SEARCH: trending romantic Hindi songs India; MUSIC_SEARCH: trending party songs India. If they say only 'play music' with no genre/title, ask which song or mood they want instead of searching. Never invent live trend rankings; the app searches YouTube results. Do not provide relay commands as tool instructions; the app handles explicit safe appliance commands separately.`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.GEMINI_MODEL || 'gemini-2.5-flash')}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const contents = [...history, { role: 'user', parts: [{ text: message }] }];
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.7, maxOutputTokens: 250 } }), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok) return res.status(response.status === 429 ? 429 : 502).json({ error: data?.error?.message || 'Gemini request failed.' });
    const reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    const match = reply.match(/(?:^|\n)MUSIC_SEARCH:\s*(.+)/i);
    res.json({ reply: reply.replace(/(?:^|\n)MUSIC_SEARCH:\s*.+/i, '').trim() || (language === 'Hinglish' ? 'Haan, batao kya help chahiye?' : 'Sure, how can I help?'), musicQuery: match?.[1]?.trim() || null });
  } catch { res.status(502).json({ error: 'Could not reach Gemini. Check network and API configuration.' }); }
});

app.listen(port, () => console.log(`HomeAI Pro HTTPS-polling backend listening on port ${port}`));
