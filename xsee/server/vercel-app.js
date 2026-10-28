const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const router = express.Router();
const idleSeconds = Number(process.env.IDLE_SECONDS) || 300;
const signalTimeoutSeconds = Number(process.env.SIGNAL_TIMEOUT_SECONDS) || 90;
const heartbeatSeconds = 30;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clientTypes = new Set([
  'SESSION_START', 'SESSION_END', 'TAB_SWITCH', 'WINDOW_BLUR', 'RETURNED',
  'IDLE_WARNING', 'WARNING_ACKNOWLEDGED', 'TRACKING_ON', 'TRACKING_OFF',
]);
const needsExam = new Set([
  'SESSION_START', 'SESSION_END', 'TAB_SWITCH', 'WINDOW_BLUR', 'RETURNED',
  'IDLE_WARNING', 'WARNING_ACKNOWLEDGED',
]);

let client;
let teacherReady;
function getDb() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured');
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

function check(result) {
  if (result.error) throw result.error;
  return result.data;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sign(payload, expiresIn) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be configured');
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

function requireRole(role) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.role !== role) throw new Error('wrong role');
      req.user = payload;
      next();
    } catch {
      res.status(401).json({ error: 'unauthorized' });
    }
  };
}

const teacherOnly = requireRole('teacher');
const studentOnly = requireRole('student');

async function ensureTeacher() {
  if (!teacherReady) {
    teacherReady = (async () => {
      const username = process.env.TEACHER_USER;
      const password = process.env.TEACHER_PASS;
      if (!username || !password) throw new Error('TEACHER_USER and TEACHER_PASS must be configured');
      const db = getDb();
      const existing = check(await db.from('teachers').select('id').eq('username', username).maybeSingle());
      if (!existing) {
        const inserted = await db.from('teachers').insert({
          username,
          password_hash: bcrypt.hashSync(password, 10),
        });
        if (inserted.error?.code !== '23505') check(inserted);
      }
    })();
  }
  await teacherReady;
}

function makeRealtimeToken(teacherId) {
  if (!process.env.SUPABASE_JWT_SECRET) throw new Error('SUPABASE_JWT_SECRET must be configured');
  return jwt.sign({
    aud: 'authenticated',
    role: 'authenticated',
    sub: String(teacherId),
    app_role: 'teacher',
  }, process.env.SUPABASE_JWT_SECRET, { expiresIn: '12h' });
}

async function loadStudent(req, res, next) {
  try {
    req.student = check(await getDb().from('students').select('*').eq('id', req.user.sid).maybeSingle());
    if (!req.student) return res.status(401).json({ error: 'unauthorized' });
    next();
  } catch (error) { next(error); }
}

async function extractFormId(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.hostname === 'forms.gle') {
    try {
      const response = await fetch(url.href, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (location) url = new URL(location);
    } catch { /* a short link may fail to resolve from the server */ }
  }
  if (url.hostname !== 'docs.google.com') return null;
  return url.pathname.match(/\/forms\/d\/(?:e\/)?([\w-]+)/)?.[1] || null;
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function realtimeConfig(teacherId) {
  if (!process.env.SUPABASE_ANON_KEY) throw new Error('SUPABASE_ANON_KEY must be configured');
  return {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    token: makeRealtimeToken(teacherId),
  };
}

router.post('/teacher/login', asyncRoute(async (req, res) => {
  await ensureTeacher();
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  const teacher = check(await getDb().from('teachers').select('*').eq('username', username).maybeSingle());
  if (!teacher || !bcrypt.compareSync(password, teacher.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  res.json({
    token: sign({ role: 'teacher', tid: teacher.id }, '12h'),
    username: teacher.username,
    realtime: realtimeConfig(teacher.id),
  });
}));

router.post('/student/login', asyncRoute(async (req, res) => {
  const full_name = String(req.body?.full_name || '').trim();
  const student_id = String(req.body?.student_id || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!full_name || full_name.length > 100) return res.status(400).json({ error: 'Full name is required' });
  if (!student_id || student_id.length > 40) return res.status(400).json({ error: 'Student ID is required' });
  if (!emailPattern.test(email) || email.length > 120) return res.status(400).json({ error: 'A valid email is required' });

  const db = getDb();
  const byEmail = check(await db.from('students').select('*').eq('email', email).maybeSingle());
  const byId = check(await db.from('students').select('*').eq('student_id', student_id).maybeSingle());
  if ((byEmail && byEmail.student_id !== student_id) || (byId && byId.email !== email)) {
    return res.status(409).json({ error: 'That email or student ID is already registered to someone else' });
  }
  let student = byEmail;
  if (student) {
    student = check(await db.from('students').update({ full_name }).eq('id', student.id).select('*').single());
  } else {
    const result = await db.from('students').insert({ student_id, full_name, email }).select('*').single();
    if (result.error?.code === '23505') {
      return res.status(409).json({ error: 'That email or student ID is already registered to someone else' });
    }
    student = check(result);
  }
  res.json({
    token: sign({ role: 'student', sid: student.id }, '14d'),
    student: { student_id: student.student_id, full_name: student.full_name, email: student.email },
  });
}));

router.get('/exams/active', asyncRoute(async (_req, res) => {
  const exams = check(await getDb().from('exams').select('form_id,exam_name').eq('status', 'active'));
  res.json({ exams, config: { idle_seconds: idleSeconds, heartbeat_seconds: heartbeatSeconds } });
}));

async function processEvent(student, event) {
  if (!event || typeof event.event_id !== 'string' || !event.event_id || event.event_id.length > 80) {
    return { ok: false, error: 'bad_event_id' };
  }
  if (!clientTypes.has(event.event_type)) return { ok: false, error: 'bad_event_type' };
  const db = getDb();
  let exam = null;
  if (event.form_id) {
    exam = check(await db.from('exams').select('*').eq('form_id', String(event.form_id)).maybeSingle());
    if (!exam || exam.status !== 'active') return { ok: false, error: 'unknown_or_closed_exam' };
  } else if (needsExam.has(event.event_type)) {
    return { ok: false, error: 'form_id_required' };
  }

  const time = new Date().toISOString();
  const numericAway = Number(event.away_seconds);
  const away = Number.isFinite(numericAway) ? Math.max(0, Math.min(86400, Math.round(numericAway))) : null;
  const detail = event.detail ? String(event.detail).slice(0, 300) : null;
  const applied = check(await db.rpc('process_xsee_event', {
    p_event_id: event.event_id,
    p_exam_id: exam?.id ?? null,
    p_student_id: student.id,
    p_event_type: event.event_type,
    p_detail: detail,
    p_away_seconds: away,
    p_client_time: event.client_time ? String(event.client_time).slice(0, 40) : null,
    p_server_time: time,
    p_closed: event.event_type === 'SESSION_END' && event.detail === 'closed',
  }));
  if (!applied) return { ok: true, duplicate: true };
  return { ok: true };
}

router.post('/events', studentOnly, loadStudent, asyncRoute(async (req, res) => {
  const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : null;
  if (!list) return res.status(400).json({ error: 'events array required' });
  const results = [];
  for (const event of list) {
    try {
      results.push({ event_id: event?.event_id, ...await processEvent(req.student, event) });
    } catch (error) {
      console.error('event failed', error);
      results.push({ event_id: event?.event_id, ok: false, error: 'server_error' });
    }
  }
  res.json({ results });
}));

router.post('/heartbeat', studentOnly, loadStudent, asyncRoute(async (req, res) => {
  const db = getDb();
  const exam = check(await db.from('exams').select('id').eq('form_id', String(req.body?.form_id || '')).maybeSingle());
  if (!exam) return res.json({ ok: false, error: 'unknown_exam' });
  const session = check(await db.from('sessions').select('*')
    .eq('exam_id', exam.id).eq('student_id', req.student.id).maybeSingle());
  if (!session || session.ended_at) return res.json({ ok: true, ignored: true });
  const time = new Date().toISOString();
  if (session.status === 'NO_SIGNAL') {
    const restored = session.prev_status || 'ACTIVE';
    check(await db.from('sessions').update({ status: restored, prev_status: null, last_seen: time }).eq('id', session.id));
    check(await db.from('logs').insert({
      event_id: `srv-${crypto.randomUUID()}`, exam_id: exam.id, student_id: req.student.id,
      event_type: 'SIGNAL_RESTORED', detail: 'Heartbeat received again', server_time: time,
    }));
  } else if (session.status !== 'UNTRACKED') {
    check(await db.from('sessions').update({ last_seen: time }).eq('id', session.id));
  }
  res.json({ ok: true });
}));

router.get('/exams', teacherOnly, asyncRoute(async (_req, res) => {
  const db = getDb();
  const exams = check(await db.from('exams').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }));
  const sessions = check(await db.from('sessions').select('exam_id,status,warning_count'));
  for (const exam of exams) {
    const rows = sessions.filter((session) => session.exam_id === exam.id);
    exam.students = rows.length;
    exam.online = rows.filter((s) => ['ACTIVE', 'AWAY', 'IDLE'].includes(s.status)).length;
    exam.warnings = rows.reduce((sum, s) => sum + s.warning_count, 0);
    exam.no_signal = rows.filter((s) => s.status === 'NO_SIGNAL').length;
  }
  res.json({ exams });
}));

router.post('/exams', teacherOnly, asyncRoute(async (req, res) => {
  const exam_name = String(req.body?.exam_name || '').trim();
  const form_url = String(req.body?.form_url || '').trim();
  if (!exam_name || exam_name.length > 120) return res.status(400).json({ error: 'Exam name is required' });
  const form_id = await extractFormId(form_url);
  if (!form_id) return res.status(400).json({ error: 'That does not look like a Google Forms link (docs.google.com/forms/...)' });
  const result = await getDb().from('exams').insert({ exam_name, form_url, form_id }).select('*').single();
  if (result.error?.code === '23505') return res.status(409).json({ error: 'This form is already registered' });
  res.status(201).json({ exam: check(result) });
}));

router.patch('/exams/:id', teacherOnly, asyncRoute(async (req, res) => {
  const status = req.body?.status;
  if (!['active', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be active or closed' });
  const result = await getDb().from('exams').update({ status }).eq('id', req.params.id).select('id').maybeSingle();
  if (!check(result)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

router.delete('/exams/:id', teacherOnly, asyncRoute(async (req, res) => {
  const result = await getDb().from('exams').delete().eq('id', req.params.id).select('id').maybeSingle();
  if (!check(result)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

router.get('/exams/:id/students', teacherOnly, asyncRoute(async (req, res) => {
  const db = getDb();
  const sessions = check(await db.from('sessions').select('*').eq('exam_id', req.params.id));
  const studentIds = sessions.map((session) => session.student_id);
  const students = studentIds.length
    ? check(await db.from('students').select('*').in('id', studentIds))
    : [];
  const byId = new Map(students.map((student) => [student.id, student]));
  res.json({ students: sessions.map((session) => {
    const student = byId.get(session.student_id);
    return {
      session_id: session.id, exam_id: session.exam_id, student_pk: student.id,
      student_id: student.student_id, full_name: student.full_name, email: student.email,
      status: session.status, tab_switch_count: session.tab_switch_count,
      idle_count: session.idle_count, warning_count: session.warning_count,
      total_away_seconds: session.total_away_seconds, started_at: session.started_at,
      ended_at: session.ended_at, last_seen: session.last_seen,
    };
  }) });
}));

async function queryLogs(req, limit) {
  const db = getDb();
  const examId = Number(req.params.id);
  const iso = (value) => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : null;
  };
  const from = iso(req.query.from);
  const to = iso(req.query.to);
  const records = [];
  const pageSize = 1000;
  for (let offset = 0; offset < limit; offset += pageSize) {
    let query = db.from('logs').select('*,students!inner(id,student_id,full_name,email)')
      .or(`exam_id.eq.${examId},exam_id.is.null`)
      .order('id', { ascending: false })
      .range(offset, Math.min(offset + pageSize, limit) - 1);
    if (req.query.student) query = query.eq('student_id', Number(req.query.student));
    if (req.query.type) query = query.eq('event_type', req.query.type);
    if (from) query = query.gte('server_time', from);
    if (to) query = query.lte('server_time', to);
    const page = check(await query);
    records.push(...page);
    if (page.length < pageSize) break;
  }
  const logs = records.filter((row) => row.exam_id === examId);
  const outside = records.filter((row) => row.exam_id == null);
  if (outside.length) {
    const sessions = check(await db.from('sessions').select('student_id,started_at,ended_at').eq('exam_id', examId));
    for (const row of outside) {
      const match = sessions.some((session) => session.student_id === row.student_id &&
        new Date(row.server_time) >= new Date(new Date(session.started_at).getTime() - 3600000) &&
        new Date(row.server_time) <= new Date(session.ended_at ? new Date(session.ended_at).getTime() + 3600000 : 8640000000000000));
      if (match) logs.push(row);
    }
  }
  return logs.sort((a, b) => a.id - b.id).map((row) => ({
    id: row.id, exam_id: row.exam_id, event_type: row.event_type, detail: row.detail,
    away_seconds: row.away_seconds, client_time: row.client_time, server_time: row.server_time,
    student_pk: row.students.id, student_id: row.students.student_id,
    full_name: row.students.full_name, email: row.students.email,
  }));
}

router.get('/exams/:id/logs', teacherOnly, asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  res.json({ logs: (await queryLogs(req, limit)).slice(-limit).reverse() });
}));

router.get('/exams/:id/export.csv', teacherOnly, asyncRoute(async (req, res) => {
  const exam = check(await getDb().from('exams').select('id').eq('id', req.params.id).maybeSingle());
  if (!exam) return res.status(404).json({ error: 'not found' });
  const rows = await queryLogs(req, 100000);
  const head = ['server_time', 'student_id', 'full_name', 'email', 'event_type', 'detail', 'away_seconds'];
  const lines = [head.join(',')].concat(rows.map((row) => head.map((key) => csvCell(row[key])).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="xsee-${exam.id}-logs.csv"`);
  res.send(lines.join('\n'));
}));

router.get('/cron/check-signals', asyncRoute(async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const cutoff = new Date(Date.now() - signalTimeoutSeconds * 1000).toISOString();
  const stale = check(await getDb().from('sessions').select('*')
    .is('ended_at', null).in('status', ['ACTIVE', 'AWAY', 'IDLE']).lt('last_seen', cutoff).limit(500));
  let changed = 0;
  for (const session of stale) {
    const now = new Date().toISOString();
    const updated = await getDb().from('sessions').update({ status: 'NO_SIGNAL', prev_status: session.status })
      .eq('id', session.id).eq('status', session.status).select('id').maybeSingle();
    if (!check(updated)) continue;
    check(await getDb().from('logs').insert({
      event_id: `srv-${crypto.randomUUID()}`, exam_id: session.exam_id, student_id: session.student_id,
      event_type: 'NO_SIGNAL',
      detail: `No heartbeat for more than ${signalTimeoutSeconds}s`, server_time: now,
    }));
    changed += 1;
  }
  res.json({ ok: true, changed });
}));

router.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use('/api', router);
app.use((error, _req, res, _next) => {
  console.error('API request failed', error);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = { app };
