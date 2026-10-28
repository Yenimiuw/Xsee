(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let savedRealtime = null;
  try { savedRealtime = JSON.parse(store.get('xsee_realtime') || 'null'); } catch {}
  const state = {
    token: store.get('xsee_token'), realtime: savedRealtime,
    exams: [], examId: null, students: [], drawer: null, realtimeClient: null, channel: null, ws: null, wsTimer: null, monitorTimer: null,
  };

  // ---------- API ----------
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { logout(); throw new Error('Session expired'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ---------- helpers ----------
  const fmtDur = (s) => {
    s = Math.round(s || 0);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + 'm' + (r ? ' ' + r + 's' : '');
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  };
  const ago = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
    return s < 5 ? 'just now' : fmtDur(s) + ' ago';
  };
  const fmtTime = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const STATUS_LABEL = { NO_SIGNAL: 'NO SIGNAL' };
  const EVENT_LABEL = {
    SESSION_START: 'Started the exam', SESSION_END: 'Finished the exam', TAB_SWITCH: 'Switched tab',
    WINDOW_BLUR: 'Left the window', RETURNED: 'Returned to the exam', IDLE_WARNING: 'Idle warning',
    WARNING_ACKNOWLEDGED: 'Warning acknowledged', TRACKING_ON: 'Tracking turned ON', TRACKING_OFF: 'Tracking turned OFF',
    NO_SIGNAL: 'Lost signal', SIGNAL_RESTORED: 'Signal restored',
  };
  const EVENT_TONE = {
    TAB_SWITCH: 'warn', WINDOW_BLUR: 'warn', IDLE_WARNING: 'warn', TRACKING_OFF: 'bad', NO_SIGNAL: 'bad',
    SESSION_END: 'good', SIGNAL_RESTORED: 'good', TRACKING_ON: 'neutral', WARNING_ACKNOWLEDGED: 'neutral',
  };

  // ---------- sound + toasts ----------
  let audio;
  function beep(freq = 740) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      [0, 0.16].forEach((d) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = freq; o.connect(g); g.connect(audio.destination);
        const t = audio.currentTime + d;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        o.start(t); o.stop(t + 0.15);
      });
    } catch {}
  }
  function toast(title, body, bad) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.innerHTML = `<b>${esc(title)}</b><span>${esc(body)}</span>`;
    const box = $('toasts');
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove(); // keep the screen usable with many students
    setTimeout(() => el.remove(), 5500);
  }

  // ---------- auth ----------
  function showLogin() {
    $('app-view').classList.add('hidden');
    $('login-view').classList.remove('hidden');
  }
  function logout() {
    store.del('xsee_token');
    store.del('xsee_realtime');
    state.token = null;
    state.realtime = null;
    if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
    clearTimeout(state.wsTimer);
    clearInterval(state.monitorTimer);
    state.monitorTimer = null;
    if (state.channel) state.realtimeClient.removeChannel(state.channel);
    state.channel = null;
    state.realtimeClient = null;
    showLogin();
  }
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    try {
      const r = await fetch('/api/teacher/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('login-user').value.trim(), password: $('login-pass').value }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Login failed');
      state.token = data.token;
      state.realtime = data.realtime;
      store.set('xsee_token', data.token);
      store.set('xsee_realtime', JSON.stringify(data.realtime));
      $('login-pass').value = '';
      enterApp();
    } catch (err) { $('login-error').textContent = err.message; }
  });
  $('logout-btn').addEventListener('click', logout);

  // ---------- exams ----------
  async function loadExams() {
    state.exams = (await api('/exams')).exams;
    renderExamList();
    const cur = state.exams.find((x) => x.id === state.examId);
    if (cur) renderExamHeader(cur);
  }
  function renderExamList() {
    const list = $('exam-list');
    if (!state.exams.length) {
      list.innerHTML = '<p class="muted small" style="padding:6px 6px">No exams yet.</p>';
      return;
    }
    list.innerHTML = state.exams.map((x) => `
      <button class="exam-item ${x.id === state.examId ? 'active' : ''}" data-id="${x.id}">
        <span class="t">${esc(x.exam_name)}</span>
        <span class="m">
          ${x.status === 'closed' ? '<span class="chip closed">Closed</span>' : ''}
          <span class="chip ${x.online ? 'live' : ''}">${x.online} online</span>
          <span class="chip">${x.students} students</span>
          ${x.warnings ? `<span class="chip warn">${x.warnings} warnings</span>` : ''}
        </span>
      </button>`).join('');
    $('empty-text').textContent = 'Pick an exam on the left to see its students and logs.';
  }
  $('exam-list').addEventListener('click', (e) => {
    const b = e.target.closest('.exam-item');
    if (b) selectExam(Number(b.dataset.id));
  });

  function renderExamHeader(x) {
    $('exam-title').textContent = x.exam_name;
    const link = $('exam-link');
    link.textContent = x.form_url; link.href = x.form_url;
    $('close-exam-btn').textContent = x.status === 'active' ? 'Close exam' : 'Reopen exam';
    $('st-students').textContent = x.students;
    $('st-online').textContent = x.online;
    $('st-warnings').textContent = x.warnings;
    $('st-nosignal').textContent = x.no_signal;
  }

  async function selectExam(id) {
    state.examId = id;
    closeDrawer();
    $('empty-state').classList.add('hidden');
    $('exam-view').classList.remove('hidden');
    renderExamList();
    const x = state.exams.find((e) => e.id === id);
    if (x) renderExamHeader(x);
    state.students = (await api(`/exams/${id}/students`)).students;
    renderTable();
  }

  function renderTable(flashId) {
    const q = $('search').value.trim().toLowerCase();
    const sf = $('status-filter').value;
    const rows = state.students.filter((s) =>
      (!sf || s.status === sf) &&
      (!q || [s.full_name, s.student_id, s.email].some((v) => v.toLowerCase().includes(q))));
    $('students-empty').classList.toggle('hidden', rows.length > 0);
    if (!rows.length && state.students.length) $('students-empty').textContent = 'No students match your filters.';
    else if (!rows.length) $('students-empty').textContent = 'No students yet. Rows appear here as soon as a student opens the exam with the extension on.';
    $('students-body').innerHTML = rows.map((s) => `
      <tr data-pk="${s.student_pk}" class="${s.session_id === flashId ? 'flash' : ''}">
        <td class="sname"><b>${esc(s.full_name)}</b><span>${esc(s.student_id)} · ${esc(s.email)}</span></td>
        <td><span class="pill ${s.status}">${STATUS_LABEL[s.status] || s.status}</span></td>
        <td class="num ${s.tab_switch_count ? 'hot' : ''}">${s.tab_switch_count}</td>
        <td class="num ${s.idle_count ? 'hot' : ''}">${s.idle_count}</td>
        <td class="num ${s.warning_count ? 'hot' : ''}">${s.warning_count}</td>
        <td class="num">${fmtDur(s.total_away_seconds)}</td>
        <td class="lastseen" data-ts="${esc(s.last_seen)}">${s.ended_at ? fmtTime(s.ended_at) : ago(s.last_seen)}</td>
      </tr>`).join('');
  }
  $('search').addEventListener('input', () => renderTable());
  $('status-filter').addEventListener('change', () => renderTable());
  $('students-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr) openDrawer(Number(tr.dataset.pk));
  });
  // keep "x ago" fresh without re-rendering the table
  setInterval(() => {
    document.querySelectorAll('#students-body td.lastseen').forEach((td) => {
      const s = state.students.find((r) => r.last_seen === td.dataset.ts);
      if (s && !s.ended_at) td.textContent = ago(td.dataset.ts);
    });
  }, 5000);

  // exam actions
  $('close-exam-btn').addEventListener('click', async () => {
    const x = state.exams.find((e) => e.id === state.examId);
    if (!x) return;
    await api(`/exams/${x.id}`, { method: 'PATCH', body: { status: x.status === 'active' ? 'closed' : 'active' } });
    await loadExams();
  });
  $('delete-exam-btn').addEventListener('click', async () => {
    const x = state.exams.find((e) => e.id === state.examId);
    if (!x || !confirm(`Delete "${x.exam_name}" and ALL of its logs? This cannot be undone.`)) return;
    await api(`/exams/${x.id}`, { method: 'DELETE' });
    state.examId = null;
    $('exam-view').classList.add('hidden');
    $('empty-state').classList.remove('hidden');
    await loadExams();
  });
  $('export-btn').addEventListener('click', async () => {
    const res = await fetch(`/api/exams/${state.examId}/export.csv`, { headers: { Authorization: 'Bearer ' + state.token } });
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `xsee-exam-${state.examId}-logs.csv` });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  // add exam dialog
  const dlg = $('exam-dialog');
  $('add-exam-btn').addEventListener('click', () => { $('ex-error').textContent = ''; $('exam-form').reset(); dlg.showModal(); $('ex-name').focus(); });
  $('ex-cancel').addEventListener('click', () => dlg.close());
  $('exam-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('ex-error').textContent = '';
    try {
      const { exam } = await api('/exams', { method: 'POST', body: { exam_name: $('ex-name').value, form_url: $('ex-url').value } });
      dlg.close();
      await loadExams();
      selectExam(exam.id);
      toast('Exam registered', `${exam.exam_name} is now being monitored.`);
    } catch (err) { $('ex-error').textContent = err.message; }
  });

  // ---------- student drawer ----------
  let drawerTimer;
  async function openDrawer(pk) {
    state.drawer = pk;
    $('drawer').classList.remove('hidden');
    ['dr-type', 'dr-from', 'dr-to'].forEach((id) => { $(id).value = ''; });
    await refreshDrawer();
  }
  function closeDrawer() { state.drawer = null; $('drawer').classList.add('hidden'); }
  $('dr-close').addEventListener('click', closeDrawer);
  ['dr-type', 'dr-from', 'dr-to'].forEach((id) => $(id).addEventListener('change', refreshDrawer));

  async function refreshDrawer() {
    if (!state.drawer) return;
    const s = state.students.find((r) => r.student_pk === state.drawer);
    if (s) {
      $('dr-name').textContent = s.full_name;
      $('dr-meta').textContent = `${s.student_id} · ${s.email}`;
      $('dr-stats').innerHTML = [
        ['Tab switches', s.tab_switch_count], ['Idle', s.idle_count], ['Warnings', s.warning_count], ['Away', fmtDur(s.total_away_seconds)],
      ].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
    }
    const p = new URLSearchParams({ student: state.drawer });
    if ($('dr-type').value) p.set('type', $('dr-type').value);
    if ($('dr-from').value) p.set('from', new Date($('dr-from').value).toISOString());
    if ($('dr-to').value) p.set('to', new Date($('dr-to').value).toISOString());
    const { logs } = await api(`/exams/${state.examId}/logs?${p}`);
    $('dr-timeline').innerHTML = logs.length ? logs.map((l) => `
      <li class="${EVENT_TONE[l.event_type] || ''}">
        <div class="ev">${esc(EVENT_LABEL[l.event_type] || l.event_type)}${l.away_seconds != null && l.event_type === 'RETURNED' ? ` · away ${fmtDur(l.away_seconds)}` : ''}</div>
        <div class="when">${esc(fmtTime(l.server_time))}${l.exam_id == null ? ' · outside the exam' : ''}</div>
        ${l.detail ? `<div class="det">${esc(l.detail)}</div>` : ''}
      </li>`).join('') : '<li class="none">No events match.</li>';
  }
  const refreshDrawerSoon = () => { clearTimeout(drawerTimer); drawerTimer = setTimeout(refreshDrawer, 250); };

  // ---------- live updates (Supabase Realtime) ----------
  function setConn(on) {
    const c = $('conn');
    c.className = 'conn ' + (on ? 'on' : 'off');
    c.querySelector('em').textContent = on ? 'Live' : 'Reconnecting…';
  }
  function connectRealtime() {
    if (!state.token) {
      setConn(false);
      return;
    }
    if (!state.realtime?.url || !state.realtime?.anonKey || !state.realtime?.token || !window.supabase) {
      connectWs();
      return;
    }
    if (state.channel) state.realtimeClient.removeChannel(state.channel);
    state.realtimeClient = window.supabase.createClient(state.realtime.url, state.realtime.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    state.realtimeClient.realtime.setAuth(state.realtime.token);
    state.channel = state.realtimeClient.channel('xsee-teacher-dashboard');
    state.channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, (event) => onLive({ type: 'update', session: event.new }))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'logs' }, (event) => onLive({ type: 'log', log: event.new }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exams' }, () => loadExams().catch(() => {}))
      .subscribe((status) => {
        const connected = status === 'SUBSCRIBED';
        setConn(connected);
        if (connected) {
          loadExams().catch(() => {});
          if (state.examId) selectExam(state.examId).catch(() => {});
        }
      });
    startSignalChecks();
  }
  function connectWs() {
    clearTimeout(state.wsTimer);
    if (!state.token) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
    state.ws = ws;
    ws.onopen = () => {
      setConn(true);
      if (state.examId) selectExam(state.examId).catch(() => {});
      loadExams().catch(() => {});
      startSignalChecks();
    };
    ws.onclose = (event) => {
      setConn(false);
      clearInterval(state.monitorTimer);
      state.monitorTimer = null;
      if (event.code === 4401) return logout();
      state.wsTimer = setTimeout(connectWs, 2000);
    };
    ws.onmessage = (event) => onLive(JSON.parse(event.data));
  }
  function startSignalChecks() {
    if (state.monitorTimer) return;
    const check = () => api('/monitor/check-signals', { method: 'POST' }).catch((error) => console.error('Signal check failed', error));
    check();
    state.monitorTimer = setInterval(check, 15000);
  }
  function onLive(msg) {
    if (msg.type === 'update') {
      if (Number(msg.session.exam_id) === Number(state.examId)) {
        selectExam(state.examId).catch(() => {});
      }
      loadExams().catch(() => {});
    } else if (msg.type === 'heartbeat') {
      const student = state.students.find((row) => row.session_id === msg.session_id);
      if (student) {
        student.last_seen = msg.last_seen;
        const cell = document.querySelector(`#students-body tr[data-pk="${student.student_pk}"] td.lastseen`);
        if (cell) { cell.dataset.ts = msg.last_seen; cell.textContent = 'just now'; }
      }
    } else if (msg.type === 'log') {
      const l = msg.log;
      const studentPk = Number(l.student_id ?? l.student_pk);
      if (state.drawer === studentPk && (Number(l.exam_id) === Number(state.examId) || l.exam_id == null)) refreshDrawerSoon();
      if (alertTypesForDashboard.has(l.event_type)) {
        const student = state.students.find((row) => row.student_pk === studentPk);
        if (student) {
          const label = EVENT_LABEL[l.event_type] || l.event_type;
          toast(student.full_name, l.detail ? `${label}\n${l.detail}` : label, l.event_type === 'NO_SIGNAL' || l.event_type === 'TRACKING_OFF');
          beep(l.event_type === 'NO_SIGNAL' ? 440 : 740);
        }
      }
    } else if (msg.type === 'alert') {
      const alert = msg.alert;
      const suffix = alert.exam_name ? ` — ${alert.exam_name}` : '';
      const label = (EVENT_LABEL[alert.event_type] || alert.event_type) + suffix;
      toast(alert.full_name, alert.detail ? `${label}\n${alert.detail}` : label, alert.event_type === 'NO_SIGNAL' || alert.event_type === 'TRACKING_OFF');
      beep(alert.event_type === 'NO_SIGNAL' ? 440 : 740);
    }
  }

  const alertTypesForDashboard = new Set(['TAB_SWITCH', 'WINDOW_BLUR', 'IDLE_WARNING', 'TRACKING_OFF', 'NO_SIGNAL']);

  // ---------- boot ----------
  async function enterApp() {
    $('login-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    try {
      await loadExams();
      if (state.exams.length && !state.examId) selectExam(state.exams[0].id);
    } catch {}
    connectRealtime();
  }
  if (state.token) enterApp(); else showLogin();
})();
