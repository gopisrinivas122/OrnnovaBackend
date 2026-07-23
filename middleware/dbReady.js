const connectDB = require('../config/db');

const dbReadyMiddleware = (req, res, next) => {
  if (connectDB.isDbReady()) {
    return next();
  }

  return res.status(503).json({
    status: 'Failed',
    msg: 'Database not connected. Add your IP to MongoDB Atlas Network Access, then restart the backend.',
  });
};

module.exports = dbReadyMiddleware;
