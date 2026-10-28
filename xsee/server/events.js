// Core logic: validates events, updates per-student session totals, detects lost signal,
// and publishes changes on a bus that the WebSocket layer forwards to the dashboard.
const db = require('./db');
const { randomUUID } = require('crypto');
const EventEmitter = require('events');

const bus = new EventEmitter();

const CLIENT_TYPES = new Set([
  'SESSION_START', 'SESSION_END', 'TAB_SWITCH', 'WINDOW_BLUR', 'RETURNED',
  'IDLE_WARNING', 'WARNING_ACKNOWLEDGED', 'TRACKING_ON', 'TRACKING_OFF',
]);
const NEEDS_EXAM = new Set([
  'SESSION_START', 'SESSION_END', 'TAB_SWITCH', 'WINDOW_BLUR', 'RETURNED',
  'IDLE_WARNING', 'WARNING_ACKNOWLEDGED',
]);
const ALERT_TYPES = new Set(['TAB_SWITCH', 'WINDOW_BLUR', 'IDLE_WARNING', 'TRACKING_OFF', 'NO_SIGNAL']);

const SIGNAL_TIMEOUT_MS = (Number(process.env.SIGNAL_TIMEOUT_SECONDS) || 90) * 1000;
const SIGNAL_CHECK_MS = Number(process.env.SIGNAL_CHECK_MS) || 10000;
const now = () => new Date().toISOString();

const q = {
  examByForm: db.prepare('SELECT * FROM exams WHERE form_id = ?'),
  examById: db.prepare('SELECT * FROM exams WHERE id = ?'),
  studentById: db.prepare('SELECT * FROM students WHERE id = ?'),
  getSession: db.prepare('SELECT * FROM sessions WHERE exam_id = ? AND student_id = ?'),
  insertSession: db.prepare(`INSERT INTO sessions (exam_id, student_id, started_at, last_seen, status)
                             VALUES (?, ?, ?, ?, ?)`),
  updateSession: db.prepare(`UPDATE sessions SET status=@status, prev_status=@prev_status, ended_at=@ended_at,
      last_seen=@last_seen, tab_switch_count=tab_switch_count+@tab, idle_count=idle_count+@idle,
      warning_count=warning_count+@warn, total_away_seconds=total_away_seconds+@away WHERE id=@id`),
  touch: db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?'),
  insertLog: db.prepare(`INSERT OR IGNORE INTO logs
      (event_id, exam_id, student_id, event_type, detail, away_seconds, client_time, server_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  stale: db.prepare(`SELECT s.* FROM sessions s JOIN exams e ON e.id = s.exam_id
      WHERE s.ended_at IS NULL AND s.status IN ('ACTIVE','AWAY','IDLE') AND s.last_seen < ?`),
  sessionView: db.prepare(`SELECT s.id AS session_id, s.exam_id, st.id AS student_pk, st.student_id, st.full_name,
      st.email, s.status, s.tab_switch_count, s.idle_count, s.warning_count, s.total_away_seconds,
      s.started_at, s.ended_at, s.last_seen
      FROM sessions s JOIN students st ON st.id = s.student_id WHERE s.id = ?`),
};

function sessionView(id) { return q.sessionView.get(id); }

function publish({ exam, student, type, detail, away, t, logId, session }) {
  bus.emit('log', {
    id: logId, exam_id: exam ? exam.id : null, student_pk: student.id, student_id: student.student_id,
    full_name: student.full_name, event_type: type, detail, away_seconds: away, server_time: t,
  });
  if (session) bus.emit('update', sessionView(session.id));
  if (ALERT_TYPES.has(type)) {
    bus.emit('alert', {
      exam_id: exam ? exam.id : null, exam_name: exam ? exam.exam_name : null,
      student_pk: student.id, student_id: student.student_id, full_name: student.full_name,
      event_type: type, detail, server_time: t,
    });
  }
}

// Apply one event to the (exam, student) session row. Must run inside a transaction.
function applyToSession(exam, student, type, away, t) {
  let s = q.getSession.get(exam.id, student.id);
  if (!s) {
    q.insertSession.run(exam.id, student.id, t, t, type === 'TRACKING_OFF' ? 'UNTRACKED' : 'ACTIVE');
    s = q.getSession.get(exam.id, student.id);
  }
  const u = { id: s.id, status: s.status, prev_status: s.prev_status, ended_at: s.ended_at,
              last_seen: t, tab: 0, idle: 0, warn: 0, away: 0 };
  switch (type) {
    case 'SESSION_START':
      if (s.status !== 'SUBMITTED') { u.status = 'ACTIVE'; u.ended_at = null; }
      break;
    case 'SESSION_END':
      u.ended_at = t;
      u.status = 'SUBMITTED';
      break;
    case 'TAB_SWITCH':
    case 'WINDOW_BLUR':
      u.status = 'AWAY'; u.tab = 1; u.warn = 1;
      break;
    case 'RETURNED':
      u.away = away || 0;
      if (s.status === 'AWAY') u.status = 'ACTIVE';
      break;
    case 'IDLE_WARNING':
      u.status = 'IDLE'; u.idle = 1; u.warn = 1;
      break;
    case 'WARNING_ACKNOWLEDGED':
      if (s.status === 'IDLE') u.status = 'ACTIVE';
      break;
    default: break; // TRACKING_OFF inside an exam: log only
  }
  q.updateSession.run(u);
  return s;
}

function processEvent(student, ev) {
  if (!ev || typeof ev.event_id !== 'string' || !ev.event_id || ev.event_id.length > 80) {
    return { ok: false, error: 'bad_event_id' };
  }
  if (!CLIENT_TYPES.has(ev.event_type)) return { ok: false, error: 'bad_event_type' };

  let exam = null;
  if (ev.form_id) {
    exam = q.examByForm.get(String(ev.form_id));
    if (!exam || exam.status !== 'active') return { ok: false, error: 'unknown_or_closed_exam' };
  } else if (NEEDS_EXAM.has(ev.event_type)) {
    return { ok: false, error: 'form_id_required' };
  }

  const t = now();
  const n = Number(ev.away_seconds);
  const away = Number.isFinite(n) ? Math.max(0, Math.min(86400, Math.round(n))) : null;
  const detail = ev.detail ? String(ev.detail).slice(0, 300) : null;
  const clientTime = ev.client_time ? String(ev.client_time).slice(0, 40) : null;
  const closed = ev.event_type === 'SESSION_END' && ev.detail === 'closed';

  const result = db.transaction(() => {
    const r = q.insertLog.run(ev.event_id, exam ? exam.id : null, student.id, ev.event_type,
      detail, away, clientTime, t);
    if (r.changes === 0) return { duplicate: true };
    let session = null;
    if (exam) {
      session = applyToSession(exam, student, ev.event_type, away, t);
      if (closed) {
        db.prepare("UPDATE sessions SET status='CLOSED' WHERE id=? AND status!='SUBMITTED'").run(session.id);
      }
    }
    return { logId: Number(r.lastInsertRowid), session };
  })();

  if (result.duplicate) return { ok: true, duplicate: true };
  publish({ exam, student, type: ev.event_type, detail, away, t, ...result });
  return { ok: true };
}

function heartbeat(student, formId) {
  const exam = q.examByForm.get(String(formId || ''));
  if (!exam) return { ok: false, error: 'unknown_exam' };
  const s = q.getSession.get(exam.id, student.id);
  if (!s || s.ended_at) return { ok: true, ignored: true };
  const t = now();
  if (s.status === 'NO_SIGNAL') {
    const restore = s.prev_status || 'ACTIVE';
    const logId = db.transaction(() => {
      db.prepare('UPDATE sessions SET status=?, prev_status=NULL, last_seen=? WHERE id=?').run(restore, t, s.id);
      return Number(q.insertLog.run('srv-' + randomUUID(), exam.id, student.id, 'SIGNAL_RESTORED',
        'Heartbeat received again', null, null, t).lastInsertRowid);
    })();
    publish({ exam, student, type: 'SIGNAL_RESTORED', detail: 'Heartbeat received again', away: null, t, logId, session: s });
  } else if (s.status !== 'UNTRACKED') {
    q.touch.run(t, s.id);
    bus.emit('heartbeat', { session_id: s.id, exam_id: exam.id, last_seen: t });
  }
  return { ok: true };
}

function checkSignals() {
  const cutoff = new Date(Date.now() - SIGNAL_TIMEOUT_MS).toISOString();
  for (const s of q.stale.all(cutoff)) {
    const exam = q.examById.get(s.exam_id);
    const student = q.studentById.get(s.student_id);
    const t = now();
    const detail = `No heartbeat for more than ${Math.round(SIGNAL_TIMEOUT_MS / 1000)}s`;
    const logId = db.transaction(() => {
      db.prepare("UPDATE sessions SET status='NO_SIGNAL', prev_status=? WHERE id=?").run(s.status, s.id);
      return Number(q.insertLog.run('srv-' + randomUUID(), s.exam_id, s.student_id, 'NO_SIGNAL',
        detail, null, null, t).lastInsertRowid);
    })();
    publish({ exam, student, type: 'NO_SIGNAL', detail, away: null, t, logId, session: s });
  }
}

let timer = null;
function startSignalMonitor() {
  if (timer) return;
  timer = setInterval(() => { try { checkSignals(); } catch (e) { console.error('signal check failed', e); } },
    SIGNAL_CHECK_MS);
  timer.unref();
}
function stopSignalMonitor() { clearInterval(timer); timer = null; }

module.exports = { bus, processEvent, heartbeat, checkSignals, startSignalMonitor, stopSignalMonitor, sessionView };
