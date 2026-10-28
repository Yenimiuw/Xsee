# Xsee (ExamSee)

Live monitoring of students taking Google Forms exams.

- Students install a Chrome extension. On exams the teacher registered, it records tab switches, window switches, time away, and idle time, and shows a warning pop-up with a beep.
- The teacher signs in to a web dashboard and sees, live, which students are active, away, idle or offline, with a full log per student.
- Local runs use SQLite. Vercel deployments use Supabase PostgreSQL and Supabase Realtime.

```
Student's Chrome + extension --> Vercel serverless API --> Supabase PostgreSQL
Teacher's browser (dashboard) --> Vercel static frontend --> Supabase Realtime
```

## Folder map

```
server/      Node.js backend (local SQLite API and Vercel/Supabase API)
api/         Vercel serverless API entry point
dashboard/   Teacher website (plain HTML/CSS/JS; Vercel static frontend)
supabase/    PostgreSQL schema and Realtime policies
extension/   Chrome extension (Manifest V3)
tools/       simulate-students.js (fake students), smoke-test.js (automatic test)
data/        created on first run: xsee.db (database) and .jwt-secret
```

## 1. Start the server

Requirements: Node.js 18 or newer.

```
cd xsee
npm install
npm start
```

You will see something like:

```
Xsee server is running
Dashboard:  http://localhost:3000
On your network: http://192.168.1.10:3000
First run: teacher account created -> teacher / teacher123
```

For a short demo where idle warnings come after 20 seconds instead of 5 minutes:

```
IDLE_SECONDS=20 npm start          (Mac/Linux)
set IDLE_SECONDS=20 && npm start   (Windows cmd)
$env:IDLE_SECONDS=20; npm start    (Windows PowerShell)
```

## Deploy frontend and backend to Vercel

The deployed **frontend** is the static dashboard in `dashboard/`. The **backend** is the serverless Express API in `api/[...path].js`, implemented by `server/vercel-app.js`. Supabase supplies the persistent PostgreSQL database and authenticated Realtime changes; Vercel's filesystem and function memory are not used for persistence.

1. Create a Supabase project. In its SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql) to create the tables, indexes, Realtime publication, and teacher-only Realtime policies.
2. In Vercel, import this repository. The included `vercel.json` sets `dashboard/` as the static output and configures the API function. No Vercel Cron is used.
3. In Vercel Project Settings → Environment Variables, define the values below for Production (and Preview if needed). Use the Supabase project URL, `anon` key, `service_role` key, and JWT secret from the Supabase project settings. Keep the service-role key and signing secrets private; only the Supabase URL and anon key are sent to the teacher's browser.
4. Set `TEACHER_USER` and a strong `TEACHER_PASS` before first use. The API creates that account on the first login request. Changing the password environment variable later does not change an already-created teacher's password.
5. Redeploy after setting environment variables. Open the Vercel deployment URL and sign in with the teacher credentials.
6. In the Chrome extension popup, set **Server address** to the same Vercel URL (for example `https://your-project.vercel.app`) before student sign-in. Approve Chrome's prompt to let the extension connect to that host.

| Environment variable | Required | Purpose |
|---|---:|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only database access; never expose or commit this key |
| `SUPABASE_ANON_KEY` | Yes | Public Supabase key used by the dashboard Realtime client |
| `SUPABASE_JWT_SECRET` | Yes | Signs short-lived teacher tokens accepted by Supabase Realtime policies |
| `JWT_SECRET` | Yes | Signs Xsee teacher and student API login tokens; use a long random value |
| `TEACHER_USER` | Yes | Username seeded when the first teacher login is attempted |
| `TEACHER_PASS` | Yes | Password hashed and stored when the teacher is first created |
| `IDLE_SECONDS` | No | Idle-warning threshold; default `300` seconds |
| `SIGNAL_TIMEOUT_SECONDS` | No | Time without a heartbeat before a student is marked `NO_SIGNAL`; default `90` seconds |

Set these in Vercel's environment-variable settings rather than committing a `.env` file. `.env.example` lists the variable names for reference. The deployed Supabase database starts empty; the existing local `data/xsee.db` is left untouched and is not automatically migrated.

No `CRON_SECRET` is needed. While a teacher dashboard is open, it calls the authenticated `/api/monitor/check-signals` endpoint every 15 seconds. The API marks sessions with overdue heartbeats as `NO_SIGNAL`, adds the event log, and Supabase Realtime updates the dashboard. If no teacher dashboard is open, checks pause; stale sessions are checked when the next teacher dashboard opens. This avoids Vercel Hobby's Cron schedule restriction.

For local development, the existing `npm start` and `npm test` commands still use SQLite and the local WebSocket server. The Vercel deployment uses Supabase instead; for local deployment testing, copy `.env.example` to `.env.local`, fill in real Supabase values, then run `npx vercel dev`. Do not commit `.env.local`.

## 2. Quick check that the backend works (no browser needed)

```
npm test
```

This starts a temporary in-memory server and checks logins, exam registration, events, duplicates, filters, no-signal detection, CSV export and live WebSocket messages. You should see "All 16 checks passed".

## 3. Log in as the teacher and register an exam

1. Open http://localhost:3000
2. Sign in with `teacher` / `teacher123`
3. Click **+ Add exam**, type an exam name, and paste the link of a Google Form.

How to get the right link: in Google Forms click **Send**, then the link icon (🔗), then Copy. It looks like
`https://docs.google.com/forms/d/e/1FAIpQLSf.../viewform`
Do not use the editor link (the one ending in `/edit`). Short `forms.gle` links also work.

Only forms registered here are monitored. Every other Google Form is ignored by the extension.

## 4. Install the extension on a student browser

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and choose the `extension` folder
4. Pin the Xsee icon (puzzle piece menu, then the pin)

## 5. Student flow

1. Click the Xsee icon. Enter full name, student ID and email. The email is filled automatically if Chrome is signed in to a Google account; you can edit it. Open "Server address" only if the server is not on this computer (see section 8).
2. Click **Sign in**. The popup now shows the tracking switch (ON by default).
3. Open the registered Google Form. A small "Xsee · Tracking ON" badge appears bottom-right.
4. Switch to another tab or another window, then come back: a warning pop-up with a beep appears and stays until you click **I understand**.
5. Stop moving the mouse and keyboard for the idle time (5 minutes by default): an idle warning appears once per idle period. Any movement counts as activity.
6. Submit the form. The toggle unlocks again.

Rules built in:
- The tracking switch is locked while an exam page is open. It can only be changed outside an exam.
- Every switch change is logged (TRACKING_ON / TRACKING_OFF) and the teacher sees it in that student's log.
- If a student opens a registered exam with tracking OFF, the page shows a notice, and the teacher sees "Tracking turned OFF" with the exam name.
- Closing the exam tab ends the session ("closed"). Reopening it resumes the same session.

## 6. Demo script (2 students + 1 teacher)

Use three browser windows:

1. Teacher: Chrome window 1 at http://localhost:3000 (signed in, exam registered).
2. Student A: Chrome window 2 (a separate Chrome profile) with the extension loaded and signed in.
3. Student B: Chrome window 3 (another profile) with the extension loaded and signed in as a different student.

Create profiles from the Chrome profile icon, then **Add**. Load the extension in each profile.

Then:
1. Both students open the exam form. Their rows appear on the dashboard as ACTIVE.
2. Student A switches tab, then comes back. The dashboard row turns AWAY, then ACTIVE again, flashes, shows a toast and beeps. Open the student to see the timeline with time away.
3. Student B stays still (start the server with `IDLE_SECONDS=20`). The row turns IDLE and an alert appears.
4. Click a student row to open the log, then try the filters (event type, date range). Click **Export CSV**.
5. Close a student's exam tab or the whole browser: the row shows CLOSED, or NO SIGNAL if the browser died.

## 7. Simulating many students (the "100 students" proof)

With the server running:

```
npm run simulate                                       5 students for 60 s
node tools/simulate-students.js --students 100 --seconds 60
```

It creates a "Simulated Exam" and fake students that switch tabs, go idle, send heartbeats and submit. Watch the dashboard fill up live.

## 8. Using different laptops and networks

The server listens on all network interfaces.

Same Wi-Fi / hotspot:
1. Run the server on the teacher's laptop and note the "On your network" address, for example `http://192.168.1.10:3000`.
2. Student laptops: in the extension popup, open **Server address** before signing in and enter that address. (To change it later: sign out, then change it.)
3. If students cannot connect, allow Node.js through the firewall on the server laptop (Windows: allow it on "Private networks").

Different networks / internet: expose the server with a tunnel, for example
```
npx cloudflared tunnel --url http://localhost:3000
```
or ngrok (`ngrok http 3000`). Use the https address it prints, both in the browser for the teacher and as the extension's Server address.

## 9. Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| PORT | 3000 | Server port |
| IDLE_SECONDS | 300 | Seconds without activity before the idle warning |
| SIGNAL_TIMEOUT_SECONDS | 90 | Seconds without a heartbeat before NO SIGNAL |
| TEACHER_USER / TEACHER_PASS | teacher / teacher123 | Teacher account created on first run |
| JWT_SECRET | auto-generated | Secret used to sign login tokens |
| DATA_DIR / DB_FILE | ./data | Where the database lives |

To start fresh, stop the server and delete the `data` folder.

## 10. How it works

Statuses: ACTIVE, AWAY (left the page), IDLE, NO_SIGNAL (heartbeats stopped), SUBMITTED, CLOSED (tab closed without submitting), UNTRACKED (opened exam with tracking off).

Events: SESSION_START, SESSION_END, TAB_SWITCH, WINDOW_BLUR, RETURNED (with away seconds), IDLE_WARNING, WARNING_ACKNOWLEDGED, TRACKING_ON, TRACKING_OFF, NO_SIGNAL, SIGNAL_RESTORED.

Heartbeats are sent every 30 seconds per open exam, are kept only in the session's "last seen" time, and are never written to the log. Events are sent as they happen; if the server is unreachable they wait in the extension's queue and are sent later. Each event has a unique ID, so retries never create duplicates.

Database tables: `teachers`, `students`, `exams`, `sessions` (one row per student per exam with running totals), `logs` (every event). Local SQLite schema is `server/schema.sql`; the Supabase schema used by Vercel is `supabase/schema.sql`.

API (all under `/api`):

```
POST /teacher/login                      teacher sign-in -> token
POST /student/login                      student register/sign-in -> token
GET  /exams/active                       list of monitored forms (used by the extension)
POST /events                             student: send a batch of events
POST /heartbeat                          student: still here
GET  /exams                              teacher: exams with live counts
POST /exams   PATCH /exams/:id   DELETE /exams/:id
GET  /exams/:id/students                 teacher: per-student summary
GET  /exams/:id/logs?student=&type=&from=&to=
GET  /exams/:id/export.csv
WS   /ws?token=...                       teacher: local development only
```

In Vercel, teacher dashboard updates are delivered from Supabase Realtime; the WebSocket endpoint is only used by the local SQLite server.

Scale: 100 students send about 3 heartbeats per second plus occasional events. SQLite with a single Node process handles this easily (the simulator runs 100 students with zero errors).

## 11. Limitations (put these in your documentation)

- The extension only sees what happens in the browser. A second device, a phone, or a second monitor with another Chrome window cannot be detected as such (using it still shows as a window switch only if that window takes focus).
- A student can disable or uninstall the extension. The dashboard shows NO SIGNAL if heartbeats stop during an exam, but cannot prevent it.
- The student's email comes from Chrome or is typed in. It is not verified with Google OAuth. Student login is by name, ID and email only, which is fine for a classroom demo but not a hardened login.
- Browsers may block the beep until the page has been clicked. Inside an exam form students normally have clicked already.
- The tab-switch pop-up appears when the student comes back (they cannot see it while away). The switch itself is logged immediately.
- Teacher login has no rate limiting, and the server uses plain HTTP unless you put it behind a tunnel or reverse proxy. Use HTTPS for anything beyond a classroom demo.
- Privacy: only status events and timestamps are recorded. No page content, answers or keystrokes. Tell students what is collected (the popup shows a consent notice) and mention the Philippine Data Privacy Act (RA 10173) in your report.

## 12. Troubleshooting

| Problem | Fix |
|---|---|
| No badge on the form | The form must be registered by the teacher and opened with a `/viewform` link. Reload the page after signing in. Check that the extension is enabled. |
| "Cannot reach the server" on sign-in | Check the Server address in the popup and that `npm start` is running. On another laptop use the network address and allow the firewall. |
| Student does not appear on dashboard | Make sure tracking is ON and you are signed in. Reload the exam page. |
| Warnings have no sound | Click anywhere on the page once; browsers block audio before any interaction. |
| Dashboard says "Reconnecting…" | The server stopped or the network dropped. It reconnects automatically. |
| Changed extension code | Go to `chrome://extensions` and press the reload icon on Xsee, then reload the form page. |
| Forgot teacher password | Stop the server, delete the `data` folder (this erases all data), start again. |
