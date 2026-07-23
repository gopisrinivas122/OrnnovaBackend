const mongoose = require('mongoose');
const { MONGO_URI } = require('./env');
const logger = require('../utils/logger');

mongoose.set('bufferCommands', false);

const connectDB = async () => {
  if (!MONGO_URI) {
    logger.error('MONGO_URI is not set in .env');
    return;
  }

  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    logger.info('Successfully Connected to MDB ✅');
  } catch (err) {
    logger.error('Failed to Connect to MDB ❌', err.message);
    logger.error('Fix: MongoDB Atlas → Network Access → Add your current IP (or 0.0.0.0/0 for dev)');
  }
};

const isDbReady = () => mongoose.connection.readyState === 1;

module.exports = connectDB;
module.exports.isDbReady = isDbReady;
