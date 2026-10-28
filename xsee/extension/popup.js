const $ = (id) => document.getElementById(id);
const ask = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));

async function render() {
  const s = await ask({ type: 'popup_state' });
  $('login-view').classList.toggle('hidden', !!s.loggedIn);
  $('main-view').classList.toggle('hidden', !s.loggedIn);

  if (!s.loggedIn) {
    $('f-server').value = s.serverUrl || '';
    // Prefill the email from the Chrome profile when available (student can still edit it).
    if (!$('f-email').value && chrome.identity?.getProfileUserInfo) {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        if (info?.email) {
          $('f-email').value = info.email;
          $('email-hint').textContent = 'Filled in from your Chrome sign-in.';
        } else {
          $('email-hint').textContent = 'Not signed in to Chrome, so please type your school email.';
        }
      });
    }
    return;
  }

  $('who-name').textContent = s.student?.full_name || '';
  $('who-meta').textContent = `${s.student?.student_id || ''} · ${s.student?.email || ''}`;
  const t = $('toggle');
  t.checked = s.tracking;
  t.disabled = s.locked;
  $('track-state').textContent = s.tracking ? 'ON — registered exams are monitored' : 'OFF — your teacher will see this';
  $('lock-note').classList.toggle('hidden', !s.locked);
  $('logout').disabled = s.locked;

  const ping = await ask({ type: 'ping' });
  $('server-state').innerHTML = `<span class="dot ${ping.ok ? 'ok' : 'bad'}"></span>${ping.ok ? 'Connected to server' : 'Server unreachable'}`;
}

$('login-view').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button.primary');
  $('login-error').textContent = '';
  btn.disabled = true;
  let serverOrigin;
  try {
    let serverUrl = $('f-server').value.trim();
    if (!/^https?:\/\//i.test(serverUrl)) serverUrl = 'http://' + serverUrl;
    serverOrigin = new URL(serverUrl).origin;
  } catch {
    btn.disabled = false;
    $('login-error').textContent = 'Enter a valid server address.';
    return;
  }
  const originPattern = serverOrigin + '/*';
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (!hasPermission) {
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
      btn.disabled = false;
      $('login-error').textContent = 'Allow access to the server address to sign in.';
      return;
    }
  }
  const r = await ask({
    type: 'login',
    serverUrl: $('f-server').value,
    full_name: $('f-name').value.trim(),
    student_id: $('f-sid').value.trim(),
    email: $('f-email').value.trim(),
  });
  btn.disabled = false;
  if (!r.ok) { $('login-error').textContent = r.error || 'Sign-in failed'; return; }
  render();
});

$('toggle').addEventListener('change', async (e) => {
  $('toggle-error').textContent = '';
  const r = await ask({ type: 'set_tracking', value: e.target.checked });
  if (!r.ok) $('toggle-error').textContent = r.error || '';
  render();
});

$('logout').addEventListener('click', async () => {
  const r = await ask({ type: 'logout' });
  if (!r.ok) $('toggle-error').textContent = r.error || '';
  render();
});

render();
