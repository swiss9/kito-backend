require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { errorHandler } = require('./middleware/errorHandler');
const { checkTmdb, checkAnilist, checkTorrentclaw, checkKv } = require('./services/healthService');
const { clearAllCache, deleteCache, getCache, setCache } = require('./services/cacheService');
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

const DEFAULT_RECOMMENDED = [
  { id: 'anilist:30', title: 'Neon Genesis Evangelion', subtitle: '1995 Â· 26 eps Â· Action, Drama, Sci-Fi', category: 'anime', poster: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx30-gJXjqBtvgs9y.jpg', provider: 'anilist', providerId: '30', hasRelease: true, hasBatch: false, collection: false },
  { id: 'anilist:12949', title: 'Kamen Rider Kuuga', subtitle: '2000 Â· 49 eps Â· Action, Adventure, Drama', category: 'tokusatsu', poster: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx12949-L6H1PTR4fyMT.png', provider: 'anilist', providerId: '12949', hasRelease: true, hasBatch: false, collection: false },
  { id: 'anilist:51009', title: 'Fullmetal Alchemist: Brotherhood', subtitle: '2009 Â· 64 eps Â· Action, Adventure, Drama', category: 'anime', poster: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx51009-8IjrnnC8ZwYd.jpg', provider: 'anilist', providerId: '51009', hasRelease: true, hasBatch: false, collection: false },
  { id: 'anilist:101685', title: 'Kamen Rider Build', subtitle: '2017 Â· 49 eps Â· Action, Comedy, Drama', category: 'tokusatsu', poster: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101685-iw0Lm92EBMCj.jpg', provider: 'anilist', providerId: '101685', hasRelease: true, hasBatch: false, collection: false },
  { id: 'tmdb:71925', title: 'Ultraman Tiga', subtitle: '1996 Â· 52 eps Â· Action, Adventure, Sci-Fi', category: 'tokusatsu', poster: 'https://image.tmdb.org/t/p/w500/7pCjKEWPqlB64WaVHrmWKKT0jqR.jpg', provider: 'tmdb', providerId: '71925', hasRelease: true, hasBatch: false, collection: false },
  { id: 'anilist:23', title: 'Cowboy Bebop', subtitle: '1998 Â· 26 eps Â· Action, Adventure, Drama', category: 'anime', poster: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx23-WBquk23FslmQ.jpg', provider: 'anilist', providerId: '23', hasRelease: true, hasBatch: false, collection: false }
];

app.get('/api/recommended', async (req, res) => {
  try {
    let shows = await getCache('recommended_shows');
    if (!shows) {
      await setCache('recommended_shows', DEFAULT_RECOMMENDED, 86400);
      shows = DEFAULT_RECOMMENDED;
    }
    res.json({ items: shows });
  } catch (err) {
    req.logger?.error({ err }, 'Failed to fetch recommended shows');
    res.status(500).json({ error: { code: 'RECOMMENDED_FAILED', message: 'Could not load recommended shows' } });
  }
});

const searchRoutes = require('./routes/search');
const mediaRoutes = require('./routes/media');
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

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    logger.info({ port }, 'KITO API running');
  });
}

module.exports = app;
