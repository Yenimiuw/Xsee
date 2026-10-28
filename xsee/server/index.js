const express = require('express');
const cors = require('cors');
const http = require('http');
const os = require('os');
const path = require('path');
const { seedTeacher } = require('./auth');
const routes = require('./routes');
const { attach } = require('./ws');
const { startSignalMonitor } = require('./events');

async function start(port = process.env.PORT || 3000) {
  const seeded = seedTeacher();

  const app = express();
  app.use(cors()); // the extension calls this API from chrome-extension:// origins
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', routes);
  app.use(express.static(path.join(__dirname, '..', 'dashboard')));

  const server = http.createServer(app);
  attach(server);
  startSignalMonitor();

  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  server.seeded = seeded;
  return server;
}

module.exports = { start };

if (require.main === module) {
  start().then((server) => {
    const port = server.address().port;
    console.log('\n  Xsee server is running');
    console.log(`  Dashboard:  http://localhost:${port}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) console.log(`  On your network: http://${i.address}:${port}`);
      }
    }
    if (server.seeded) {
      console.log(`  First run: teacher account created -> ${server.seeded.username} / ${server.seeded.password}`);
    }
    console.log('');
  });
}
