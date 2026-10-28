const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

// JWT secret: from env, else generated once and kept next to the database.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.DB_FILE === ':memory:') return crypto.randomBytes(32).toString('hex');
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const f = path.join(dir, '.jwt-secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  fs.mkdirSync(dir, { recursive: true });
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

const sign = (payload, expiresIn) => jwt.sign(payload, SECRET, { expiresIn });
const verify = (token) => jwt.verify(token, SECRET);

function requireRole(role) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try {
      const p = verify(token);
      if (p.role !== role) throw new Error('wrong role');
      req.user = p;
      next();
    } catch {
      res.status(401).json({ error: 'unauthorized' });
    }
  };
}

// Create the default teacher account on first run.
function seedTeacher() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM teachers').get().n;
  if (count > 0) return null;
  const username = process.env.TEACHER_USER || 'teacher';
  const password = process.env.TEACHER_PASS || 'teacher123';
  db.prepare('INSERT INTO teachers (username, password_hash) VALUES (?, ?)')
    .run(username, bcrypt.hashSync(password, 10));
  return { username, password };
}

module.exports = { sign, verify, requireRole, seedTeacher, bcrypt };
