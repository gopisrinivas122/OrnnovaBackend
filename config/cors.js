const cors = require('cors');

const allowedOrigins = [
  'http://localhost:3000',
  'https://frontend-fge2.vercel.app',
  'https://frontend-theta-mocha-38.vercel.app',
  'https://hr.ornnova.com',
  'https://ornnova.com',
];

const corsOptions = {
  origin(origin, callback) {
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};

module.exports = cors(corsOptions);
