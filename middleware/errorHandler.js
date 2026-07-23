const multer = require('multer');
const logger = require('../utils/logger');

const registerErrorHandlers = (app) => {
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || (err.message && err.message.includes('Invalid file type')) || (err.message && err.message.includes('Unsupported file type'))) {
      if (!res.headersSent) {
        return res.status(400).json({ status: 'Failed', msg: err.message });
      }
      return;
    }
    next(err);
  });

  app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err.message);
    if (!res.headersSent) {
      if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ status: 'Failed', msg: 'Not allowed by CORS' });
      }
      if (err.name === 'ValidationError') {
        return res.status(400).json({ status: 'Failed', msg: err.message });
      }
      if (err.name === 'CastError') {
        return res.status(400).json({ status: 'Failed', msg: 'Invalid ID format' });
      }
      return res.status(500).json({ status: 'Failed', msg: 'Internal Server Error' });
    }
  });

  app.use((req, res) => {
    if (!res.headersSent) {
      res.status(404).json({ status: 'Failed', msg: 'API endpoint not found' });
    }
  });
};

module.exports = { registerErrorHandlers };
