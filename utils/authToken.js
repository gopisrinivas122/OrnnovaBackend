const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');

const TOKEN_EXPIRY = process.env.JWT_EXPIRES_IN || '8h';

const signAccessToken = (user) => {
  return jwt.sign(
    {
      id: String(user._id),
      email: user.Email,
      role: user.UserType,
      name: user.EmployeeName,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
};

const verifyAccessToken = (token) => jwt.verify(token, JWT_SECRET);

module.exports = {
  signAccessToken,
  verifyAccessToken,
  TOKEN_EXPIRY,
};
