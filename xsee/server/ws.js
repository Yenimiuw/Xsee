// WebSocket hub: pushes live updates to logged-in teacher dashboards.
const { WebSocketServer } = require('ws');
const { verify } = require('./auth');
const { bus } = require('./events');

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    try {
      if (verify(token).role !== 'teacher') throw new Error('wrong role');
    } catch {
      return ws.close(4401, 'unauthorized');
    }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(JSON.stringify({ type: 'hello' }));
  });

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  };
  bus.on('update', (session) => broadcast({ type: 'update', session }));
  bus.on('log', (log) => broadcast({ type: 'log', log }));
  bus.on('alert', (alert) => broadcast({ type: 'alert', alert }));
  bus.on('heartbeat', (hb) => broadcast({ type: 'heartbeat', ...hb }));

  const ping = setInterval(() => {
    for (const c of wss.clients) {
      if (!c.isAlive) { c.terminate(); continue; }
      c.isAlive = false;
      c.ping();
    }
  }, 30000);
  ping.unref();
  wss.on('close', () => clearInterval(ping));
  return wss;
}

module.exports = { attach };
