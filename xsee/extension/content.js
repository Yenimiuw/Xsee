// Xsee content script: runs on Google Forms pages. It only starts monitoring when the background
// worker confirms this form is a registered exam, the student is signed in, and tracking is ON.
(() => {
  if (window.__xseeLoaded) return;
  window.__xseeLoaded = true;

  const m = location.pathname.match(/\/forms\/d\/(?:e\/)?([\w-]+)/);
  if (!m) return;
  const formId = m[1];
  const phase = /\/formResponse/.test(location.pathname) ? 'submitted'
    : /\/viewform/.test(location.pathname) ? 'viewform' : null;
  if (!phase) return; // e.g. the form editor

  const BLUE = '#1f4fd8', NAVY = '#0e2a6b', ORANGE = '#ff7a1a', OFFWHITE = '#faf7f2';

  // ---------- UI (shadow DOM so Google's CSS can't touch it) ----------
  let host, root;
  function ui() {
    if (host) return root;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        .badge { position: fixed; right: 14px; bottom: 14px; pointer-events: auto; display: flex; align-items: center; gap: 8px;
                 background: ${NAVY}; color: #fff; font-size: 12.5px; font-weight: 600; padding: 7px 12px; border-radius: 999px;
                 box-shadow: 0 6px 18px rgba(14,42,107,.35); }
        .badge b { color: ${ORANGE}; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #3ddc97; }
        .badge.off .dot { background: ${ORANGE}; }
        .banner { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); pointer-events: auto; max-width: min(560px, 92vw);
                  background: ${OFFWHITE}; color: ${NAVY}; border: 2px solid ${ORANGE}; border-radius: 12px; padding: 10px 16px;
                  font-size: 14px; box-shadow: 0 10px 30px rgba(14,42,107,.25); }
        .scrim { position: fixed; inset: 0; background: rgba(14,42,107,.55); display: grid; place-items: center; pointer-events: auto; }
        .modal { background: ${OFFWHITE}; width: min(440px, 92vw); border-radius: 20px; padding: 26px 26px 22px; text-align: center;
                 box-shadow: 0 24px 70px rgba(0,0,0,.4); border-top: 6px solid ${ORANGE}; animation: pop .18s ease-out; }
        @keyframes pop { from { transform: scale(.94); opacity: 0; } to { transform: none; opacity: 1; } }
        .icon { width: 54px; height: 54px; border-radius: 50%; background: ${ORANGE}; color: #fff; font-size: 30px; font-weight: 800;
                display: grid; place-items: center; margin: 0 auto 12px; }
        h2 { margin: 0 0 8px; color: ${NAVY}; font-size: 21px; }
        ul { list-style: none; margin: 0 0 18px; padding: 0; color: #3c4967; font-size: 15px; line-height: 1.45; }
        li + li { margin-top: 8px; padding-top: 8px; border-top: 1px solid #e8e2d6; }
        small { display: block; color: #6b7691; margin-bottom: 16px; }
        button { font: inherit; font-weight: 700; background: ${BLUE}; color: #fff; border: 0; border-radius: 12px; padding: 11px 22px; cursor: pointer; }
        button:hover { background: #173a8c; }
      </style>
      <div id="layer"></div>`;
    document.documentElement.appendChild(host);
    return root;
  }
  const layer = () => ui().getElementById('layer');

  function badge(text, off) {
    const el = document.createElement('div');
    el.className = 'badge' + (off ? ' off' : '');
    el.innerHTML = `<span class="dot"></span><span><b>X</b>see · ${text}</span>`;
    layer().appendChild(el);
  }
  function banner(text) {
    const el = document.createElement('div');
    el.className = 'banner';
    el.textContent = text;
    layer().appendChild(el);
    setTimeout(() => el.remove(), 12000);
  }

  // ---------- warning overlay + beep ----------
  let actx;
  function beep() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      [0, 0.2].forEach((d) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(actx.destination);
        const t = actx.currentTime + d;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.start(t); o.stop(t + 0.18);
      });
    } catch { /* sound is best-effort */ }
  }

  let modal = null, modalMsgs = [];
  function warn(message) {
    beep();
    modalMsgs.push(message);
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'scrim';
      modal.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true">
        <div class="icon">!</div><h2>Warning recorded</h2><ul></ul>
        <small>Your teacher can see this activity.</small><button type="button">I understand</button></div>`;
      modal.querySelector('button').addEventListener('click', () => {
        const summary = modalMsgs.join(' | ');
        modal.remove(); modal = null; modalMsgs = [];
        lastActivity = Date.now();
        send('WARNING_ACKNOWLEDGED', summary.slice(0, 280));
      });
      layer().appendChild(modal);
    }
    const ul = modal.querySelector('ul');
    ul.innerHTML = '';
    modalMsgs.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    modal.querySelector('button').focus();
  }

  // ---------- messaging ----------
  function send(event_type, detail, away_seconds) {
    try {
      chrome.runtime.sendMessage({ type: 'event', event_type, detail, away_seconds, client_time: new Date().toISOString() }, () => void chrome.runtime.lastError);
    } catch { /* extension was reloaded; the page needs a refresh */ }
  }
  const fmt = (s) => (s < 60 ? `${s} seconds` : `${Math.floor(s / 60)} min ${s % 60} sec`);

  // ---------- monitoring ----------
  let lastActivity = Date.now(), idleWarned = false, awayStart = null;

  function startMonitoring(cfg) {
    const idleMs = Math.max(5, cfg.idle_seconds) * 1000;
    badge('Tracking ON');

    // Leaving the page: a hidden tab = tab switch / minimised; blur with a visible page = another window.
    function leave(kind) {
      if (awayStart) return;
      awayStart = Date.now();
      if (kind === 'hidden') send('TAB_SWITCH', 'Switched to another tab or minimised the browser');
      else send('WINDOW_BLUR', 'Window lost focus (switched to another app or window)');
    }
    function back() {
      if (!awayStart || document.hidden || !document.hasFocus()) return;
      const secs = Math.max(0, Math.round((Date.now() - awayStart) / 1000));
      awayStart = null; lastActivity = Date.now(); idleWarned = false;
      send('RETURNED', `Returned after ${secs}s`, secs);
      warn(`You left the exam page and were away for ${fmt(secs)}.`);
    }
    document.addEventListener('visibilitychange', () => (document.hidden ? leave('hidden') : back()));
    window.addEventListener('blur', () => setTimeout(() => { if (!document.hasFocus()) leave(document.hidden ? 'hidden' : 'blur'); }, 0));
    window.addEventListener('focus', back);

    // Any mouse / keyboard / scroll / touch counts as activity.
    ['mousemove', 'mousedown', 'keydown', 'wheel', 'scroll', 'touchstart', 'pointerdown'].forEach((t) =>
      window.addEventListener(t, () => { lastActivity = Date.now(); idleWarned = false; }, { passive: true, capture: true }));

    // One warning per idle period; the overlay stays until the student dismisses it.
    setInterval(() => {
      if (awayStart || document.hidden || idleWarned) return;
      if (Date.now() - lastActivity >= idleMs) {
        idleWarned = true;
        const secs = Math.round(idleMs / 1000);
        send('IDLE_WARNING', `No activity for ${secs}s`);
        warn(`No activity detected for ${fmt(secs)}. Are you still there?`);
      }
    }, 1000);

    window.addEventListener('pagehide', () => {
      try { chrome.runtime.sendMessage({ type: 'unloading' }, () => void chrome.runtime.lastError); } catch {}
    });
  }

  // ---------- start ----------
  try {
    chrome.runtime.sendMessage({ type: 'init', form_id: formId, phase }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      if (res.track) return startMonitoring(res);
      if (res.reason === 'login') {
        badge('Not signed in', true);
        banner('Xsee: this exam is monitored. Click the Xsee icon in your toolbar, sign in, then reload this page.');
      } else if (res.reason === 'tracking_off') {
        badge('Tracking OFF', true);
        banner('Xsee: this exam requires tracking. Turn it ON in the Xsee popup and reload this page. Your teacher has been notified.');
      }
    });
  } catch { /* extension context invalid */ }
})();
