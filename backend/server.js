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

module.exports = app;
