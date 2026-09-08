const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const client = require('prom-client');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  path: "/socket.io"
});

// Middleware Safety & Utility
app.use(helmet());
app.use(cors());
app.use(express.json());

// Global Rate Limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Terlalu banyak request. Silakan coba lagi nanti.' }
});
app.use('/api/', apiLimiter);

// PostgreSQL Connection
const pool = new Pool({
  host: process.env.DATABASE_HOST || 'postgres',
  port: process.env.DATABASE_PORT || 5432,
  database: process.env.POSTGRES_DB || 'devops_message',
  user: process.env.POSTGRES_USER || 'devops',
  password: process.env.POSTGRES_PASSWORD || 'devops_secure_password_2026',
});

// Redis Connection
const redisClient = redis.createClient({
  url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`
});
redisClient.on('error', (err) => console.error('Redis Error:', err));
redisClient.connect().catch(console.error);

// Prometheus Metrics setup
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 1, 3, 5]
});
const totalMessagesCounter = new client.Counter({
  name: 'app_messages_sent_total',
  help: 'Total messages sent in application'
});
const activeUsersGauge = new client.Gauge({
  name: 'app_active_users_current',
  help: 'Number of active users currently logged in'
});
register.registerMetric(httpRequestDuration);
register.registerMetric(totalMessagesCounter);
register.registerMetric(activeUsersGauge);

// Request Duration Tracker Middleware
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.route ? req.route.path : req.path, status_code: res.statusCode });
  });
  next();
});

// Initialization: Database Tables & Admin User Seeding
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INT REFERENCES users(id),
        receiver_id INT REFERENCES users(id),
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL,
        deleted_by INT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        admin_id INT REFERENCES users(id),
        action VARCHAR(100) NOT NULL,
        target_type VARCHAR(50),
        target_id INT,
        description TEXT,
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed / Sinkronisasi akun admin dari .env
    // Kalau container Postgres sudah pernah jalan sebelumnya (volume lama), baris admin
    // lama tetap ada di DB dan tidak ter-insert ulang -> makanya ditambahkan logic
    // sinkronisasi di bawah supaya email/username/password admin SELALU mengikuti .env
    // terbaru, tidak "nyangkut" di data lama.
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@devops.local';
    const adminPass = process.env.ADMIN_PASSWORD || 'adminops';

    const checkAdmin = await pool.query(
      "SELECT * FROM users WHERE username = $1 OR role = 'admin' LIMIT 1",
      [adminUser]
    );

    if (checkAdmin.rows.length === 0) {
      const hash = await bcrypt.hash(adminPass, 10);
      await pool.query(
        'INSERT INTO users (username, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)',
        [adminUser, adminEmail, hash, 'admin', 'active']
      );
      console.log('Seeded default admin account successfully.');
    } else {
      const existingAdmin = checkAdmin.rows[0];
      const passMatches = await bcrypt.compare(adminPass, existingAdmin.password_hash);
      const needsSync = existingAdmin.username !== adminUser
        || existingAdmin.email !== adminEmail
        || !passMatches
        || existingAdmin.role !== 'admin'
        || existingAdmin.status !== 'active';

      if (needsSync) {
        const hash = await bcrypt.hash(adminPass, 10);
        await pool.query(
          "UPDATE users SET username = $1, email = $2, password_hash = $3, role = 'admin', status = 'active' WHERE id = $4",
          [adminUser, adminEmail, hash, existingAdmin.id]
        );
        console.log('Admin account synced with current .env credentials.');
      }
    }
  } catch (err) {
    console.error('Database Init Failed:', err);
  }
}
initDb();

// Audit Logger Helper Function
async function logAudit(adminId, action, targetType, targetId, description, ip) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (admin_id, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6)',
      [adminId, action, targetType, targetId, description, ip || '0.0.0.0']
    );
  } catch (err) {
    console.error('Audit Logging Error:', err);
  }
}

// Authentication Middlewares
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Akses ditolak. Token tidak ditemukan.' });

  jwt.verify(token, process.env.JWT_SECRET || 'secret', async (err, user) => {
    if (err) return res.status(403).json({ error: 'Token tidak valid atau kedaluwarsa.' });

    // Verify if user is suspended atau sudah dihapus (soft delete)
    const checkUser = await pool.query('SELECT status FROM users WHERE id = $1', [user.id]);
    if (checkUser.rows.length === 0 || checkUser.rows[0].status === 'suspended' || checkUser.rows[0].status === 'deleted') {
      return res.status(403).json({ error: 'Akun Anda dinonaktifkan/suspended/sudah dihapus.' });
    }

    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Akses terlarang. Diperlukan role Admin.' });
  }
}

// --- HEALTH & METRICS ENDPOINTS ---
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/health/database', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', database: e.message });
  }
});
app.get('/health/redis', async (req, res) => {
  try {
    await redisClient.ping();
    res.json({ status: 'ok', redis: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', redis: e.message });
  }
});
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// --- AUTH ROUTES ---
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password, confirmPassword } = req.body;
  if (!username || !email || !password || password !== confirmPassword) {
    return res.status(400).json({ error: 'Input tidak valid atau konfirmasi password tidak sesuai.' });
  }

  try {
    const existing = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $2', [username, email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username atau Email sudah terdaftar.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const newUser = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, role',
      [username, email, hash]
    );

    res.status(201).json({ message: 'Registrasi berhasil.', user: newUser.rows[0] });
    io.emit('admin:update', { type: 'user_registered' });
  } catch (err) {
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    // Bisa login pakai email ATAU username (mis. admin login dengan "admin", bukan "admin@devops.local")
    const result = await pool.query('SELECT * FROM users WHERE email = $1 OR username = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Email/Username atau password salah.' });

    const user = result.rows[0];
    if (user.status === 'suspended' || user.status === 'deleted') {
      return res.status(403).json({ error: 'Akun Anda dinonaktifkan/suspended/sudah dihapus.' });
    }

    const validPass = await bcrypt.compare(password, user.password_hash);
    if (!validPass) return res.status(400).json({ error: 'Email/Username atau password salah.' });

    await pool.query('UPDATE users SET last_activity = NOW() WHERE id = $1', [user.id]);
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '12h' }
    );

    res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// --- USER & MESSAGING ROUTES ---
app.get('/api/users', authenticateToken, async (req, res) => {
  const search = req.query.search || '';
  try {
    // role != 'admin' -> admin disembunyikan dari daftar kontak biasa,
    // KECUALI sudah pernah ada percakapan (mis. admin pernah kirim pesan peringatan) -> tetap muncul supaya bisa dibuka/dibalas
    const users = await pool.query(
      `SELECT id, username, email, status, last_activity 
       FROM users 
       WHERE id != $1 AND username ILIKE $2 AND status = 'active'
         AND (
           role != 'admin'
           OR EXISTS (
             SELECT 1 FROM messages m
             WHERE (m.sender_id = $1 AND m.receiver_id = users.id)
                OR (m.sender_id = users.id AND m.receiver_id = $1)
           )
         )
       ORDER BY username ASC`,
      [req.user.id, `%${search}%`]
    );
    res.json(users.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages', authenticateToken, async (req, res) => {
  const withUserId = req.query.with;
  if (!withUserId) return res.status(400).json({ error: 'Parameter query `with` diperlukan.' });

  try {
    const messages = await pool.query(
      `SELECT m.id, m.sender_id, m.receiver_id, m.message, m.created_at, m.deleted_at, m.deleted_by,
              u1.username AS sender_name, u2.username AS receiver_name
       FROM messages m
       JOIN users u1 ON m.sender_id = u1.id
       JOIN users u2 ON m.receiver_id = u2.id
       WHERE ((m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1))
       ORDER BY m.created_at ASC`,
      [req.user.id, withUserId]
    );
    
    // Mask text if deleted
    const masked = messages.rows.map(msg => ({
      ...msg,
      message: msg.deleted_at ? 'Pesan ini telah dihapus.' : msg.message
    }));

    res.json(masked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages', authenticateToken, async (req, res) => {
  const { receiver_id, message } = req.body;
  if (!receiver_id || !message) return res.status(400).json({ error: 'Penerima dan pesan wajib diisi.' });

  try {
    const newMsg = await pool.query(
      'INSERT INTO messages (sender_id, receiver_id, message) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, receiver_id, message]
    );
    totalMessagesCounter.inc();

    const fullMsg = {
      ...newMsg.rows[0],
      sender_name: req.user.username
    };

    io.emit(`chat_${receiver_id}`, fullMsg);
    io.emit('admin:update', { type: 'message_sent' });
    res.status(201).json(fullMsg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Soft Delete Message (Strict Authorization)
app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
  const messageId = req.params.id;
  try {
    const msg = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    if (msg.rows.length === 0) return res.status(404).json({ error: 'Pesan tidak ditemukan.' });

    // Authorization check: User can only delete their own messages unless Admin
    if (msg.rows[0].sender_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Akses ditolak! Anda tidak dapat menghapus pesan milik user lain.' });
    }

    await pool.query(
      'UPDATE messages SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2',
      [req.user.id, messageId]
    );

    if (req.user.role === 'admin') {
      await logAudit(req.user.id, 'DELETE_MESSAGE', 'message', messageId, 'Admin menghapus pesan user', req.ip);
    }

    io.emit('message_deleted', { id: messageId });
    io.emit('admin:update', { type: 'message_deleted' });
    res.json({ message: 'Pesan berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ADMIN ENDPOINTS ---
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
    const totalMessages = await pool.query('SELECT COUNT(*) FROM messages');
    const activeUsers = await pool.query('SELECT COUNT(*) FROM users WHERE status = \'active\'');
    const suspendedUsers = await pool.query('SELECT COUNT(*) FROM users WHERE status = \'suspended\'');
    const todayUsers = await pool.query('SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE');
    const todayMessages = await pool.query('SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE');

    res.json({
      totalUsers: parseInt(totalUsers.rows[0].count),
      totalMessages: parseInt(totalMessages.rows[0].count),
      activeUsers: parseInt(activeUsers.rows[0].count),
      suspendedUsers: parseInt(suspendedUsers.rows[0].count),
      todayUsers: parseInt(todayUsers.rows[0].count),
      todayMessages: parseInt(todayMessages.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/user-growth', authenticateToken, requireAdmin, async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  try {
    const growth = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count 
       FROM users 
       WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' * $1
       GROUP BY DATE(created_at) 
       ORDER BY DATE(created_at) ASC`,
      [days]
    );
    res.json(growth.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/message-activity', authenticateToken, requireAdmin, async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  try {
    const activity = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count 
       FROM messages 
       WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' * $1
       GROUP BY DATE(created_at) 
       ORDER BY DATE(created_at) ASC`,
      [days]
    );
    res.json(activity.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';

  try {
    // status != 'deleted' -> user yang sudah dihapus (soft-delete) tidak lagi tampil di daftar admin
    const users = await pool.query(
      `SELECT id, username, email, role, status, created_at, last_activity 
       FROM users 
       WHERE (username ILIKE $1 OR email ILIKE $1) AND status != 'deleted'
       ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [`%${search}%`, limit, offset]
    );
    const total = await pool.query(
      "SELECT COUNT(*) FROM users WHERE (username ILIKE $1 OR email ILIKE $1) AND status != 'deleted'",
      [`%${search}%`]
    );

    res.json({ users: users.rows, total: parseInt(total.rows[0].count), page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/kick', authenticateToken, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    // role != 'admin' -> mencegah admin menendang akun admin lain (termasuk dirinya sendiri)
    const result = await pool.query(
      "UPDATE users SET status = 'suspended' WHERE id = $1 AND role != 'admin' RETURNING id",
      [userId]
    );
    if (result.rowCount === 0) {
      return res.status(400).json({ error: 'User tidak ditemukan atau tidak bisa menonaktifkan akun admin.' });
    }
    await logAudit(req.user.id, 'KICK_USER', 'user', userId, 'Admin menonaktifkan/menendang user', req.ip);
    io.emit('admin:update', { type: 'user_kicked' });
    res.json({ message: 'User berhasil dinonaktifkan/kicked.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const { status } = req.body;
  try {
    await pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, userId]);
    await logAudit(req.user.id, 'UPDATE_STATUS', 'user', userId, `Status user diubah menjadi ${status}`, req.ip);
    io.emit('admin:update', { type: 'user_status_changed' });
    res.json({ message: `Status user berhasil diubah menjadi ${status}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hapus user (soft delete) - HANYA untuk user yang sedang berstatus suspended.
// Datanya tidak dihapus permanen dari database (status diubah jadi 'deleted') supaya
// riwayat pesan lawan bicaranya tetap utuh dan tidak melanggar foreign key.
app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    const target = await pool.query('SELECT id, role, status FROM users WHERE id = $1', [userId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'User tidak ditemukan.' });
    if (target.rows[0].role === 'admin') return res.status(403).json({ error: 'Akun admin tidak bisa dihapus.' });
    if (target.rows[0].status !== 'suspended') {
      return res.status(400).json({ error: 'Hanya user berstatus suspended yang bisa dihapus. Kick/suspend user ini terlebih dahulu.' });
    }

    await pool.query("UPDATE users SET status = 'deleted' WHERE id = $1", [userId]);
    await logAudit(req.user.id, 'DELETE_USER', 'user', userId, 'Admin menghapus (soft-delete) user', req.ip);
    io.emit('admin:update', { type: 'user_deleted' });
    res.json({ message: 'User berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/messages', authenticateToken, requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';

  try {
    const messages = await pool.query(
      `SELECT m.id, m.message, m.created_at, m.deleted_at,
              u1.username AS sender, u2.username AS receiver
       FROM messages m
       JOIN users u1 ON m.sender_id = u1.id
       JOIN users u2 ON m.receiver_id = u2.id
       WHERE m.message ILIKE $1 OR u1.username ILIKE $1 OR u2.username ILIKE $1
       ORDER BY m.id DESC LIMIT $2 OFFSET $3`,
      [`%${search}%`, limit, offset]
    );
    const total = await pool.query('SELECT COUNT(*) FROM messages');

    res.json({ messages: messages.rows, total: parseInt(total.rows[0].count), page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/audit-logs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const logs = await pool.query(
      `SELECT a.*, u.username as admin_name 
       FROM audit_logs a 
       LEFT JOIN users u ON a.admin_id = u.id 
       ORDER BY a.created_at DESC LIMIT 50`
    );
    res.json(logs.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset password user (admin tidak pernah bisa "melihat" password asli - hash bcrypt satu arah,
// jadi yang disediakan adalah set password BARU, bukan menampilkan yang lama)
app.patch('/api/admin/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const { newPassword, confirmPassword } = req.body;

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password baru minimal 6 karakter.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Konfirmasi password tidak sesuai.' });
  }

  try {
    const target = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
    await logAudit(req.user.id, 'RESET_PASSWORD', 'user', userId, `Admin mereset password user ${target.rows[0].username}`, req.ip);

    res.json({ message: 'Password user berhasil direset.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Broadcast pesan peringatan admin ke SEMUA user aktif (non-admin).
// Diselipkan lewat tabel messages yang sudah ada (sender_id = admin) supaya
// muncul langsung di kotak chat masing-masing user tanpa perlu tabel baru.
app.post('/api/admin/broadcast', authenticateToken, requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Isi pesan wajib diisi.' });
  }

  try {
    const targets = await pool.query(
      "SELECT id, username FROM users WHERE role != 'admin' AND status = 'active'"
    );

    for (const target of targets.rows) {
      const inserted = await pool.query(
        'INSERT INTO messages (sender_id, receiver_id, message) VALUES ($1, $2, $3) RETURNING *',
        [req.user.id, target.id, message]
      );
      totalMessagesCounter.inc();
      io.emit(`chat_${target.id}`, { ...inserted.rows[0], sender_name: req.user.username });
    }

    await logAudit(req.user.id, 'BROADCAST_MESSAGE', 'user', null, `Admin mengirim pesan peringatan ke ${targets.rows.length} user`, req.ip);
    io.emit('admin:update', { type: 'broadcast_sent' });

    res.json({ message: `Pesan berhasil dikirim ke ${targets.rows.length} user.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Websocket Handling
io.on('connection', (socket) => {
  activeUsersGauge.inc();
  socket.on('disconnect', () => {
    activeUsersGauge.dec();
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});