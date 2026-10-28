// Xsee background service worker.
// Talks to the server over REST (service workers get suspended, so no long-lived socket here),
// keeps an offline queue, sends heartbeats, and tracks which tabs are inside a registered exam.
const DEFAULT_SERVER = 'http://localhost:3000';
const EXAM_CACHE_MS = 15000;
const UNLOAD_GRACE_MS = 4000;

// ---------- storage helpers ----------
const local = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
};
const sess = chrome.storage.session; // survives service-worker restarts, cleared when the browser closes

let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

const normalizeUrl = (u) => {
  u = String(u || '').trim().replace(/\/+$/, '');
  if (!u) return DEFAULT_SERVER;
  return /^https?:\/\//i.test(u) ? u : 'http://' + u;
};

async function getState() {
  const s = await local.get(['serverUrl', 'token', 'student', 'tracking']);
  return {
    serverUrl: normalizeUrl(s.serverUrl),
    token: s.token || null,
    student: s.student || null,
    tracking: s.tracking !== false, // default ON
  };
}

async function examTabs() { return (await sess.get('examTabs')).examTabs || {}; }
const setExamTabs = (examTabs) => sess.set({ examTabs });

// ---------- server calls ----------
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const st = await getState();
  const headers = { 'Content-Type': 'application/json' };
  if (auth && st.token) headers.Authorization = 'Bearer ' + st.token;
  const res = await fetch(st.serverUrl + '/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && auth) await local.set({ token: null }); // token expired -> popup asks to sign in again
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function getExams(force) {
  const c = await local.get(['examsCache']);
  const cache = c.examsCache;
  if (!force && cache && Date.now() - cache.at < EXAM_CACHE_MS) return cache;
  try {
    const r = await api('/exams/active', { auth: false });
    if (r.ok) {
      const fresh = { at: Date.now(), exams: r.data.exams, config: r.data.config };
      await local.set({ examsCache: fresh });
      return fresh;
    }
  } catch { /* offline: fall back to the old cache */ }
  return cache || { at: 0, exams: [], config: { idle_seconds: 300, heartbeat_seconds: 30 } };
}

// ---------- event queue (survives offline periods) ----------
function enqueue(ev) {
  const full = { event_id: crypto.randomUUID(), client_time: new Date().toISOString(), ...ev };
  return serial(async () => {
    const { queue = [] } = await local.get(['queue']);
    queue.push(full);
    await local.set({ queue: queue.slice(-500) });
  }).then(flush);
}

function flush() {
  return serial(async () => {
    const st = await getState();
    const { queue = [] } = await local.get(['queue']);
    if (!st.token || !queue.length) return;
    const batch = queue.slice(0, 50);
    try {
      const r = await api('/events', { method: 'POST', body: { events: batch } });
      if (r.ok) {
        // The server answers per event (accepted, duplicate or rejected); none need resending.
        const { queue: cur = [] } = await local.get(['queue']);
        await local.set({ queue: cur.slice(batch.length) });
      }
    } catch { /* server unreachable: keep queue, retry on next alarm */ }
  });
}

async function sendHeartbeats() {
  const st = await getState();
  if (!st.token) return;
  const forms = new Set(Object.values(await examTabs()));
  for (const form_id of forms) {
    try { await api('/heartbeat', { method: 'POST', body: { form_id } }); } catch { /* offline */ }
  }
}

// ---------- tracking state ----------
async function addExamTab(tabId, form_id) {
  const t = await examTabs(); t[tabId] = form_id; await setExamTabs(t);
}
async function removeExamTab(tabId) {
  const t = await examTabs();
  const form_id = t[tabId];
  if (form_id) { delete t[tabId]; await setExamTabs(t); }
  return form_id;
}

const pendingClose = new Map(); // tabId -> timer (page unloading: reload, submit or really leaving?)

async function onInit(msg, sender) {
  const tabId = sender.tab.id;
  clearTimeout(pendingClose.get(tabId)); pendingClose.delete(tabId);

  const { exams, config } = await getExams();
  const exam = exams.find((e) => e.form_id === msg.form_id);
  if (!exam) return { track: false, reason: 'not_registered' };

  const st = await getState();
  if (!st.token) return { track: false, reason: 'login', exam_name: exam.exam_name };

  if (msg.phase === 'submitted') {
    await removeExamTab(tabId);
    if (st.tracking) enqueue({ form_id: msg.form_id, event_type: 'SESSION_END', detail: 'submitted' });
    return { track: false, reason: 'submitted', exam_name: exam.exam_name };
  }
  if (!st.tracking) {
    enqueue({ form_id: msg.form_id, event_type: 'TRACKING_OFF', detail: 'Opened this exam while tracking was turned off' });
    return { track: false, reason: 'tracking_off', exam_name: exam.exam_name };
  }
  await addExamTab(tabId, msg.form_id);
  enqueue({ form_id: msg.form_id, event_type: 'SESSION_START', detail: 'Opened the exam' });
  api('/heartbeat', { method: 'POST', body: { form_id: msg.form_id } }).catch(() => {});
  return { track: true, exam_name: exam.exam_name, idle_seconds: config.idle_seconds, student: st.student };
}

async function onUnloading(tabId) {
  const t = await examTabs();
  if (!t[tabId]) return;
  clearTimeout(pendingClose.get(tabId));
  pendingClose.set(tabId, setTimeout(async () => {
    pendingClose.delete(tabId);
    const form_id = await removeExamTab(tabId);
    if (form_id) enqueue({ form_id, event_type: 'SESSION_END', detail: 'closed' });
  }, UNLOAD_GRACE_MS));
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearTimeout(pendingClose.get(tabId)); pendingClose.delete(tabId);
  const form_id = await removeExamTab(tabId);
  if (form_id) enqueue({ form_id, event_type: 'SESSION_END', detail: 'closed' });
});

// ---------- popup API ----------
async function popupState() {
  const st = await getState();
  const tabs = await examTabs();
  return {
    serverUrl: st.serverUrl, loggedIn: !!st.token, student: st.student, tracking: st.tracking,
    locked: Object.keys(tabs).length > 0,
  };
}

async function login({ serverUrl, full_name, student_id, email }) {
  await local.set({ serverUrl: normalizeUrl(serverUrl) });
  try {
    const r = await api('/student/login', { method: 'POST', auth: false, body: { full_name, student_id, email } });
    if (!r.ok) return { ok: false, error: r.data.error || 'Sign-in failed' };
    await local.set({ token: r.data.token, student: r.data.student });
    getExams(true);
    flush();
    return { ok: true };
  } catch {
    return { ok: false, error: 'Cannot reach the server. Check the server address and that it is running.' };
  }
}

async function setTracking(value) {
  if (Object.keys(await examTabs()).length) return { ok: false, error: 'Tracking cannot be changed during an exam.' };
  await local.set({ tracking: !!value });
  const st = await getState();
  if (st.token) {
    enqueue({
      event_type: value ? 'TRACKING_ON' : 'TRACKING_OFF',
      detail: value ? 'Student turned tracking on' : 'Student turned tracking off',
    });
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'init': return onInit(msg, sender);
      case 'event': {
        const form_id = (await examTabs())[sender.tab?.id];
        if (!form_id) return { ok: false };
        await enqueue({ form_id, event_type: msg.event_type, detail: msg.detail, away_seconds: msg.away_seconds, client_time: msg.client_time });
        return { ok: true };
      }
      case 'unloading': return onUnloading(sender.tab.id);
      case 'popup_state': return popupState();
      case 'login': return login(msg);
      case 'set_tracking': return setTracking(msg.value);
      case 'logout': {
        if (Object.keys(await examTabs()).length) return { ok: false, error: 'Cannot sign out during an exam.' };
        await local.set({ token: null, student: null });
        return { ok: true };
      }
      case 'set_server': await local.set({ serverUrl: normalizeUrl(msg.serverUrl) }); getExams(true); return { ok: true };
      case 'ping': {
        try { const r = await api('/exams/active', { auth: false }); return { ok: r.ok }; } catch { return { ok: false }; }
      }
      default: return null;
    }
  })().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async response
});

// ---------- heartbeat alarm (service workers sleep, alarms wake them) ----------
function ensureAlarm() {
  chrome.alarms.get('xsee-hb', (a) => { if (!a) chrome.alarms.create('xsee-hb', { periodInMinutes: 0.5 }); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'xsee-hb') return;
  sendHeartbeats();
  flush();
  getExams(true);
});
