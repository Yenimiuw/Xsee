// End-to-end backend test. Starts the server in-process with a throwaway in-memory database.
process.env.DB_FILE = ':memory:';
process.env.SIGNAL_TIMEOUT_SECONDS = '2';
process.env.SIGNAL_CHECK_MS = '500';
process.env.IDLE_SECONDS = '7';

const assert = require('assert');
const WebSocket = require('ws');
const { start } = require('../server');

let n = 0;
const ok = (msg) => console.log(`  ok ${++n} - ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  let evCounter = 0;
  const ev = (event_type, extra = {}) => ({ event_id: `t-${++evCounter}`, event_type, client_time: new Date().toISOString(), ...extra });

  console.log('Xsee backend smoke test');

  // teacher auth
  assert.equal((await call('POST', '/api/teacher/login', { username: 'teacher', password: 'nope' })).status, 401);
  const tl = await call('POST', '/api/teacher/login', { username: 'teacher', password: 'teacher123' });
  assert.equal(tl.status, 200);
  const T = tl.body.token;
  ok('teacher login (bad password rejected, default account works)');

  assert.equal((await call('GET', '/api/exams')).status, 401);
  ok('teacher endpoints require a token');

  // live dashboard socket
  const msgs = [];
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${T}`);
  ws.on('message', (m) => msgs.push(JSON.parse(m))); // attach before open so 'hello' isn't missed
  await new Promise((r) => ws.on('open', r));
  const badWs = new WebSocket(`${base.replace('http', 'ws')}/ws?token=bad`);
  const closeCode = await new Promise((r) => badWs.on('close', r));
  assert.equal(closeCode, 4401);
  ok('websocket accepts teacher token, rejects bad token');

  // exams
  assert.equal((await call('POST', '/api/exams', { exam_name: 'X', form_url: 'https://example.com/forms/d/e/abc/viewform' }, T)).status, 400);
  const ex = await call('POST', '/api/exams', { exam_name: 'Midterm Quiz', form_url: 'https://docs.google.com/forms/d/e/1FAIpQLSdemo123/viewform?usp=sf_link' }, T);
  assert.equal(ex.status, 201);
  assert.equal(ex.body.exam.form_id, '1FAIpQLSdemo123');
  const examId = ex.body.exam.id;
  assert.equal((await call('POST', '/api/exams', { exam_name: 'Dup', form_url: 'https://docs.google.com/forms/d/e/1FAIpQLSdemo123/viewform' }, T)).status, 409);
  ok('exam registration extracts form id, rejects non-Google and duplicate links');

  const active = await call('GET', '/api/exams/active');
  assert.deepEqual(active.body.exams.map((e) => e.form_id), ['1FAIpQLSdemo123']);
  assert.equal(active.body.config.idle_seconds, 7);
  ok('extension can fetch the active exam list + config');

  // student
  assert.equal((await call('POST', '/api/student/login', { full_name: 'Ana Cruz', student_id: '2024-001', email: 'bad' })).status, 400);
  const sl = await call('POST', '/api/student/login', { full_name: 'Ana Cruz', student_id: '2024-001', email: 'Ana@School.edu' });
  assert.equal(sl.status, 200);
  const S = sl.body.token;
  assert.equal(sl.body.student.email, 'ana@school.edu');
  assert.equal((await call('POST', '/api/student/login', { full_name: 'Mallory', student_id: '2024-999', email: 'ana@school.edu' })).status, 409);
  assert.equal((await call('POST', '/api/events', { events: [] }, T)).status, 401);
  ok('student registration, email normalised, identity clashes rejected, roles separated');

  const F = '1FAIpQLSdemo123';
  const send = async (events) => (await call('POST', '/api/events', { events }, S)).body.results;

  // event flow
  const start1 = ev('SESSION_START', { form_id: F });
  let r = await send([start1, start1]);
  assert.equal(r[0].ok, true); assert.equal(r[1].duplicate, true);
  ok('duplicate event_id is ignored (idempotent retries)');

  r = await send([
    ev('TAB_SWITCH', { form_id: F, detail: 'x' }),
    ev('RETURNED', { form_id: F, away_seconds: 42 }),
    ev('IDLE_WARNING', { form_id: F }),
    ev('WARNING_ACKNOWLEDGED', { form_id: F }),
    ev('WINDOW_BLUR', { form_id: F }),
    ev('RETURNED', { form_id: F, away_seconds: 8 }),
  ]);
  assert.ok(r.every((x) => x.ok));
  let st = (await call('GET', `/api/exams/${examId}/students`, null, T)).body.students;
  assert.equal(st.length, 1);
  assert.equal(st[0].tab_switch_count, 2);
  assert.equal(st[0].idle_count, 1);
  assert.equal(st[0].warning_count, 3);
  assert.equal(st[0].total_away_seconds, 50);
  assert.equal(st[0].status, 'ACTIVE');
  ok('session totals: 2 tab switches, 1 idle, 3 warnings, 50s away');

  r = await send([ev('NOPE', { form_id: F }), ev('TAB_SWITCH'), ev('TAB_SWITCH', { form_id: 'unknown' }), ev('NO_SIGNAL', { form_id: F })]);
  assert.ok(r.every((x) => x.ok === false));
  ok('invalid / client-forged event types and unregistered forms are rejected');

  // tracking toggle outside exam
  r = await send([ev('TRACKING_OFF', { detail: 'Student turned tracking off' }), ev('TRACKING_ON')]);
  assert.ok(r.every((x) => x.ok));
  const logs = (await call('GET', `/api/exams/${examId}/logs`, null, T)).body.logs;
  assert.ok(logs.some((l) => l.event_type === 'TRACKING_OFF' && l.exam_id === null));
  ok('tracking on/off outside an exam appears in that student\'s exam log');

  // filters
  const onlyTab = (await call('GET', `/api/exams/${examId}/logs?type=TAB_SWITCH`, null, T)).body.logs;
  assert.equal(onlyTab.length, 1);
  const future = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await call('GET', `/api/exams/${examId}/logs?from=${encodeURIComponent(future)}`, null, T)).body.logs.length, 0);
  ok('log filters (type, date) work');

  // heartbeat + no signal
  await call('POST', '/api/heartbeat', { form_id: F }, S);
  await sleep(3200);
  st = (await call('GET', `/api/exams/${examId}/students`, null, T)).body.students;
  assert.equal(st[0].status, 'NO_SIGNAL');
  await call('POST', '/api/heartbeat', { form_id: F }, S);
  st = (await call('GET', `/api/exams/${examId}/students`, null, T)).body.students;
  assert.equal(st[0].status, 'ACTIVE');
  ok('missing heartbeats -> NO_SIGNAL, heartbeat resumes -> restored');

  // submit
  await send([ev('SESSION_END', { form_id: F, detail: 'submitted' })]);
  st = (await call('GET', `/api/exams/${examId}/students`, null, T)).body.students;
  assert.equal(st[0].status, 'SUBMITTED');
  await sleep(2600);
  st = (await call('GET', `/api/exams/${examId}/students`, null, T)).body.students;
  assert.equal(st[0].status, 'SUBMITTED');
  ok('submitted sessions are not flagged NO_SIGNAL afterwards');

  // exam list, csv
  const list = (await call('GET', '/api/exams', null, T)).body.exams[0];
  assert.equal(list.students, 1); assert.equal(list.warnings, 3);
  const csv = await call('GET', `/api/exams/${examId}/export.csv`, null, T);
  assert.ok(csv.body.startsWith('server_time,student_id') && csv.body.includes('TAB_SWITCH'));
  ok('exam summary counts and CSV export');

  // live push
  const types = new Set(msgs.map((m) => m.type));
  for (const t of ['hello', 'update', 'log', 'alert', 'heartbeat']) assert.ok(types.has(t), 'missing ws message: ' + t);
  assert.ok(msgs.some((m) => m.type === 'alert' && m.alert.event_type === 'NO_SIGNAL'));
  ok('dashboard received live update / log / alert / heartbeat messages');

  // closed exam stops tracking
  await call('PATCH', `/api/exams/${examId}`, { status: 'closed' }, T);
  assert.equal((await call('GET', '/api/exams/active')).body.exams.length, 0);
  r = await send([ev('TAB_SWITCH', { form_id: F })]);
  assert.equal(r[0].ok, false);
  ok('closing an exam removes it from the active list and stops accepting events');

  console.log(`\nAll ${n} checks passed`);
  ws.close();
  server.close();
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
