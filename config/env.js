require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 7993,
  MONGO_URI: process.env.MONGO_URI,
  EMAIL: process.env.EMAIL,
  PASSWORD: process.env.PASSWORD,
  SECRET_KEY: process.env.SECRET_KEY,
  JWT_SECRET: process.env.JWT_SECRET || process.env.SECRET_KEY || 'ornnova-dev-secret-change-me',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  UPLOAD_DIR: process.env.UPLOAD_DIR,
};
