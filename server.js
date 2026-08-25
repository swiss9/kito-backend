require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { errorHandler } = require('./middleware/errorHandler');
const { checkTmdb, checkAnilist, checkTorrentclaw } = require('./services/healthService');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || 'https://kito.app',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
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

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'KITO API running on Vercel.' });
});

const searchRoutes = require('./routes/search');
const mediaRoutes = require('./routes/media');
app.use('/api', searchRoutes);
app.use('/api', mediaRoutes);

app.get('/api/health', async (req, res) => {
  const checks = {
    tmdb: await checkTmdb(),
    anilist: await checkAnilist(),
    torrentclaw: await checkTorrentclaw()
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
  app.listen(port, () => console.log(`KITO API running on ${port}`));
}

module.exports = app;
