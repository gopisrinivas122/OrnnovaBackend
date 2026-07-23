const express = require('express');
const compression = require('compression');
const path = require('path');
const cors = require('./config/cors');
const connectDB = require('./config/db');
const dbReadyMiddleware = require('./middleware/dbReady');
const { authMiddleware } = require('./middleware/auth');
const { uploadDir } = require('./config/multer');
const { registerErrorHandlers } = require('./middleware/errorHandler');
const registerRoutes = require('./routes');

const app = express();

connectDB();

app.use(compression());
app.use(express.json());
app.use(cors);
app.use('/uploads', express.static(uploadDir));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    database: connectDB.isDbReady() ? 'connected' : 'disconnected',
    port: process.env.PORT || 7993,
  });
});

app.use(dbReadyMiddleware);
app.use(authMiddleware);
registerRoutes(app);
registerErrorHandlers(app);

module.exports = app;
