const express = require('express');
const cors = require('cors');
require('dotenv').config();

const searchRoutes = require('./routes/search');
const mediaRoutes = require('./routes/media');

const app = express();
app.use(cors());
app.options('*', cors());
app.use(express.json());

app.use('/api', searchRoutes);
app.use('/api', mediaRoutes);

app.get('/', (req, res) => res.send('KITO API running on Vercel.'));

// Start server locally when not in serverless environment
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`KITO API listening on port ${port}`);
  });
}

module.exports = app;
