require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { errorHandler } = require('./middleware/errorHandler');
const { checkTmdb, checkAnilist, checkTorrentclaw, checkKv } = require('./services/healthService');
const { clearAllCache, deleteCache } = require('./services/cacheService');
const logger = require('./services/logger');

const app = express();

app.set('trust proxy', 1);

app.use((req, res, next) => {
  let requestId = req.headers['x-request-id'];
  if (!requestId) {
    requestId = crypto.randomUUID();
  }
  req.id = requestId;
  req.logger = logger.child({ requestId });
  res.setHeader('x-request-id', requestId);
  req.logger.info({ method: req.method, url: req.url }, 'Request received');
  next();
});

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-admin-token']
}));
app.use(compression());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests' } }
});
app.use('/api', limiter);

const adminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'ADMIN_RATE_LIMIT', message: 'Too many admin requests' } }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'KITO API running on Vercel.' });
});

app.delete('/api/admin/cache', adminLimiter, async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid admin token' } });
  }

  const key = req.query.key;
  if (key !== undefined && (typeof key !== 'string' || !key.trim())) {
    return res.status(400).json({ error: { code: 'INVALID_KEY', message: 'Cache key must be a non-empty string' } });
  }

  try {
    if (key) {
      await deleteCache(key);
      res.json({ success: true, cleared: key });
    } else {
      await clearAllCache();
      res.json({ success: true, cleared: 'all' });
    }
  } catch (err) {
    req.logger.error({ err }, 'Cache clear failed');
    res.status(500).json({
      error: {
        code: 'CACHE_CLEAR_FAILED',
        message: err.message || 'Cache clear operation failed'
      }
    });
  }
});

const searchRoutes = require('./routes/search');
const mediaRoutes = require('./routes/media');
app.use('/api/v1', searchRoutes);
app.use('/api/v1', mediaRoutes);
app.use('/api', searchRoutes);
app.use('/api', mediaRoutes);

app.get('/api/health', async (req, res) => {
  const checks = {
    tmdb: await checkTmdb(),
    anilist: await checkAnilist(),
    torrentclaw: await checkTorrentclaw(),
    kv: await checkKv()
  };
  const healthy = Object.values(checks).every(c => c === 'ok');
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
});

app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

app.use(errorHandler);

const server = app.listen(process.env.PORT || 3000, () => {
  logger.info({ port: process.env.PORT || 3000 }, 'KITO API running');
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing server');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, closing server');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

module.exports = app;
