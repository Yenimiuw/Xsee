#!/usr/bin/env node
// Simulates students taking an exam so you can watch the dashboard react without real browsers.
//
//   node tools/simulate-students.js                       (5 students, 60 seconds)
//   node tools/simulate-students.js --students 100 --seconds 90
//   node tools/simulate-students.js --server http://192.168.1.10:3000
//
// Options: --server URL  --students N  --seconds N  --teacher USER  --password PASS  --exam "Name"
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));

const SERVER = (args.server || 'http://localhost:3000').replace(/\/+$/, '');
const COUNT = Number(args.students) || 5;
const SECONDS = Number(args.seconds) || 60;
const EXAM_NAME = args.exam || 'Simulated Exam';
const FORM_ID = '1FAIpQLSxseeSimulatedForm';
const FORM_URL = `https://docs.google.com/forms/d/e/${FORM_ID}/viewform`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const uuid = () => crypto.randomUUID();

async function call(method, path, body, token) {
  const res = await fetch(SERVER + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const FIRST = ['Ana', 'Ben', 'Carla', 'Dino', 'Ella', 'Fe', 'Gabe', 'Hana', 'Ian', 'Jo', 'Kai', 'Lia', 'Marco', 'Nina', 'Oscar', 'Pia'];
const LAST = ['Reyes', 'Cruz', 'Santos', 'Garcia', 'Bautista', 'Ocampo', 'Flores', 'Mendoza', 'Torres', 'Navarro'];

async function main() {
  // Make sure the simulated exam exists (needs the teacher account).
  const tl = await call('POST', '/teacher/login', { username: args.teacher || 'teacher', password: args.password || 'teacher123' });
  if (tl.status !== 200) {
    const active = await call('GET', '/exams/active');
    if (!active.body.exams?.some((e) => e.form_id === FORM_ID)) {
      console.error('Could not log in as teacher to create the exam. Pass --teacher and --password.');
      process.exit(1);
    }
  } else {
    const active = await call('GET', '/exams/active');
    if (!active.body.exams.some((e) => e.form_id === FORM_ID)) {
      const r = await call('POST', '/exams', { exam_name: EXAM_NAME, form_url: FORM_URL }, tl.body.token);
      if (r.status === 409) { // exists but closed: reopen it
        const list = await call('GET', '/exams', null, tl.body.token);
        const ex = list.body.exams.find((e) => e.form_id === FORM_ID);
        await call('PATCH', `/exams/${ex.id}`, { status: 'active' }, tl.body.token);
      } else if (r.status !== 201) { console.error('Could not create exam:', r.body); process.exit(1); }
      console.log(`Created exam "${EXAM_NAME}"`);
    }
  }

  console.log(`Simulating ${COUNT} students for ${SECONDS}s against ${SERVER} ... (Ctrl+C to stop)`);
  const stats = { events: 0, heartbeats: 0, errors: 0 };
  const stop = Date.now() + SECONDS * 1000;

  async function student(i) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]} ${i >= 16 ? i : ''}`.trim();
    const login = await call('POST', '/student/login', {
      full_name: name, student_id: `SIM-${String(i + 1).padStart(4, '0')}`, email: `sim${i + 1}@example.edu`,
    });
    if (login.status !== 200) { stats.errors++; return; }
    const token = login.body.token;
    const send = async (event_type, extra = {}) => {
      const r = await call('POST', '/events', { events: [{ event_id: uuid(), form_id: FORM_ID, event_type, client_time: new Date().toISOString(), ...extra }] }, token);
      r.status === 200 ? stats.events++ : stats.errors++;
    };
    const hb = async () => { const r = await call('POST', '/heartbeat', { form_id: FORM_ID }, token); r.status === 200 ? stats.heartbeats++ : stats.errors++; };

    await sleep(rand(0, 3000)); // stagger joins
    await send('SESSION_START', { detail: 'Opened the exam' });
    // compressed time: heartbeat every 10s instead of 30s
    const hbTimer = setInterval(hb, 10000);
    // a few students are "troublemakers" who switch tabs more
    const restless = Math.random() < 0.25;
    while (Date.now() < stop - 4000) {
      await sleep(rand(4000, restless ? 9000 : 25000));
      if (Date.now() >= stop - 4000) break;
      const roll = Math.random();
      if (roll < 0.6) {
        const away = Math.round(rand(3, 40));
        await send(Math.random() < 0.7 ? 'TAB_SWITCH' : 'WINDOW_BLUR', { detail: 'Simulated: left the exam page' });
        await sleep(Math.min(away, 8) * 1000);
        await send('RETURNED', { away_seconds: away, detail: `Returned after ${away}s` });
        await send('WARNING_ACKNOWLEDGED', { detail: 'Simulated acknowledge' });
      } else if (roll < 0.85) {
        await send('IDLE_WARNING', { detail: 'Simulated: no activity' });
        await sleep(3000);
        await send('WARNING_ACKNOWLEDGED', { detail: 'Simulated acknowledge' });
      }
    }
    clearInterval(hbTimer);
    await send('SESSION_END', { detail: 'submitted' });
  }

  const progress = setInterval(() => process.stdout.write(`\r  events sent: ${stats.events}  heartbeats: ${stats.heartbeats}  errors: ${stats.errors}   `), 1000);
  await Promise.all(Array.from({ length: COUNT }, (_, i) => student(i)));
  clearInterval(progress);
  console.log(`\nDone. events: ${stats.events}, heartbeats: ${stats.heartbeats}, errors: ${stats.errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
