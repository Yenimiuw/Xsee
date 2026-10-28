const express = require('express');
const db = require('./db');
const { sign, requireRole, bcrypt } = require('./auth');
const events = require('./events');

const router = express.Router();
const teacherOnly = requireRole('teacher');
const studentOnly = requireRole('student');

const IDLE_SECONDS = Number(process.env.IDLE_SECONDS) || 300;
const HEARTBEAT_SECONDS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- helpers --------------------------------------------------------------------------------
async function extractFormId(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.hostname === 'forms.gle') { // short link: follow one redirect to find the real form id
    try {
      const r = await fetch(u.href, { redirect: 'manual' });
      const loc = r.headers.get('location');
      if (loc) u = new URL(loc);
    } catch { /* fall through */ }
  }
  if (u.hostname !== 'docs.google.com') return null;
  const m = u.pathname.match(/\/forms\/d\/(?:e\/)?([\w-]+)/);
  return m ? m[1] : null;
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// ---- teacher auth ---------------------------------------------------------------------------
router.post('/teacher/login', (req, res) => {
  const { username, password } = req.body || {};
  const t = db.prepare('SELECT * FROM teachers WHERE username = ?').get(String(username || ''));
  if (!t || !bcrypt.compareSync(String(password || ''), t.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  res.json({ token: sign({ role: 'teacher', tid: t.id }, '12h'), username: t.username });
});

// ---- student auth + extension endpoints ------------------------------------------------------
router.post('/student/login', (req, res) => {
  const full_name = String(req.body?.full_name || '').trim();
  const student_id = String(req.body?.student_id || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!full_name || full_name.length > 100) return res.status(400).json({ error: 'Full name is required' });
  if (!student_id || student_id.length > 40) return res.status(400).json({ error: 'Student ID is required' });
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'A valid email is required' });

  const byEmail = db.prepare('SELECT * FROM students WHERE email = ?').get(email);
  const byId = db.prepare('SELECT * FROM students WHERE student_id = ?').get(student_id);
  if ((byEmail && byEmail.student_id !== student_id) || (byId && byId.email !== email)) {
    return res.status(409).json({ error: 'That email or student ID is already registered to someone else' });
  }
  let student = byEmail;
  if (student) db.prepare('UPDATE students SET full_name = ? WHERE id = ?').run(full_name, student.id);
  else {
    const r = db.prepare('INSERT INTO students (student_id, full_name, email) VALUES (?, ?, ?)')
      .run(student_id, full_name, email);
    student = db.prepare('SELECT * FROM students WHERE id = ?').get(r.lastInsertRowid);
  }
  res.json({
    token: sign({ role: 'student', sid: student.id }, '14d'),
    student: { student_id, full_name, email },
  });
});

// Public: lets the extension know which forms are monitored (form ids are not secret).
router.get('/exams/active', (req, res) => {
  const exams = db.prepare("SELECT form_id, exam_name FROM exams WHERE status = 'active'").all();
  res.json({ exams, config: { idle_seconds: IDLE_SECONDS, heartbeat_seconds: HEARTBEAT_SECONDS } });
});

function loadStudent(req, res, next) {
  const s = db.prepare('SELECT * FROM students WHERE id = ?').get(req.user.sid);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  req.student = s;
  next();
}

router.post('/events', studentOnly, loadStudent, (req, res) => {
  const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : null;
  if (!list) return res.status(400).json({ error: 'events array required' });
  const results = list.map((ev) => {
    try { return { event_id: ev?.event_id, ...events.processEvent(req.student, ev) }; }
    catch (e) { console.error('event failed', e); return { event_id: ev?.event_id, ok: false, error: 'server_error' }; }
  });
  res.json({ results });
});

router.post('/heartbeat', studentOnly, loadStudent, (req, res) => {
  res.json(events.heartbeat(req.student, req.body?.form_id));
});

// ---- teacher: exams ---------------------------------------------------------------------------
router.get('/exams', teacherOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT e.id, e.exam_name, e.form_url, e.form_id, e.status, e.created_at,
           COUNT(s.id) AS students,
           COALESCE(SUM(CASE WHEN s.status IN ('ACTIVE','AWAY','IDLE') THEN 1 ELSE 0 END), 0) AS online,
           COALESCE(SUM(s.warning_count), 0) AS warnings,
           COALESCE(SUM(CASE WHEN s.status = 'NO_SIGNAL' THEN 1 ELSE 0 END), 0) AS no_signal
    FROM exams e LEFT JOIN sessions s ON s.exam_id = e.id
    GROUP BY e.id ORDER BY e.created_at DESC, e.id DESC`).all();
  res.json({ exams: rows });
});

router.post('/exams', teacherOnly, async (req, res) => {
  const exam_name = String(req.body?.exam_name || '').trim();
  const form_url = String(req.body?.form_url || '').trim();
  if (!exam_name || exam_name.length > 120) return res.status(400).json({ error: 'Exam name is required' });
  const form_id = await extractFormId(form_url);
  if (!form_id) {
    return res.status(400).json({ error: 'That does not look like a Google Forms link (docs.google.com/forms/...)' });
  }
  if (db.prepare('SELECT 1 FROM exams WHERE form_id = ?').get(form_id)) {
    return res.status(409).json({ error: 'This form is already registered' });
  }
  const r = db.prepare('INSERT INTO exams (exam_name, form_url, form_id) VALUES (?, ?, ?)')
    .run(exam_name, form_url, form_id);
  res.status(201).json({ exam: db.prepare('SELECT * FROM exams WHERE id = ?').get(r.lastInsertRowid) });
});

router.patch('/exams/:id', teacherOnly, (req, res) => {
  const status = req.body?.status;
  if (!['active', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be active or closed' });
  const r = db.prepare('UPDATE exams SET status = ? WHERE id = ?').run(status, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

router.delete('/exams/:id', teacherOnly, (req, res) => {
  const r = db.prepare('DELETE FROM exams WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

router.get('/exams/:id/students', teacherOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id AS session_id, s.exam_id, st.id AS student_pk, st.student_id, st.full_name, st.email,
           s.status, s.tab_switch_count, s.idle_count, s.warning_count, s.total_away_seconds,
           s.started_at, s.ended_at, s.last_seen
    FROM sessions s JOIN students st ON st.id = s.student_id
    WHERE s.exam_id = ? ORDER BY st.full_name COLLATE NOCASE`).all(req.params.id);
  res.json({ students: rows });
});

// Logs for one exam. Tracking on/off events done outside the exam (exam_id NULL) are included
// for students who have a session in this exam, within 1 hour of that session.
const LOG_SQL = `
  SELECT l.id, l.exam_id, l.event_type, l.detail, l.away_seconds, l.client_time, l.server_time,
         st.id AS student_pk, st.student_id, st.full_name, st.email
  FROM logs l JOIN students st ON st.id = l.student_id
  WHERE (l.exam_id = @exam OR (l.exam_id IS NULL AND EXISTS (
          SELECT 1 FROM sessions s WHERE s.exam_id = @exam AND s.student_id = l.student_id
            AND l.server_time >= strftime('%Y-%m-%dT%H:%M:%fZ', s.started_at, '-1 hour')
            AND l.server_time <= COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', s.ended_at, '+1 hour'), '9999-12-31T23:59:59Z'))))
    AND (@student IS NULL OR l.student_id = @student)
    AND (@type IS NULL OR l.event_type = @type)
    AND (@from IS NULL OR l.server_time >= @from)
    AND (@to IS NULL OR l.server_time <= @to)`;

function queryLogs(req, order, limit) {
  const iso = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toISOString() : null; };
  return db.prepare(`${LOG_SQL} ORDER BY l.id ${order} LIMIT ${limit}`).all({
    exam: Number(req.params.id),
    student: req.query.student ? Number(req.query.student) : null,
    type: req.query.type || null,
    from: iso(req.query.from),
    to: iso(req.query.to),
  });
}

router.get('/exams/:id/logs', teacherOnly, (req, res) => {
  res.json({ logs: queryLogs(req, 'DESC', Math.min(Number(req.query.limit) || 500, 2000)) });
});

router.get('/exams/:id/export.csv', teacherOnly, (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if (!exam) return res.status(404).json({ error: 'not found' });
  const rows = queryLogs(req, 'ASC', 100000);
  const head = ['server_time', 'student_id', 'full_name', 'email', 'event_type', 'detail', 'away_seconds'];
  const lines = [head.join(',')].concat(rows.map((r) => head.map((h) => csvCell(r[h])).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="xsee-${exam.id}-logs.csv"`);
  res.send(lines.join('\n'));
});

router.use((req, res) => res.status(404).json({ error: 'not found' }));

module.exports = router;
