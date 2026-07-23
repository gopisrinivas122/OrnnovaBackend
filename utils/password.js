const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

const isPasswordHashed = (value = '') => /^\$2[aby]\$\d{2}\$/.test(value);

const hashPassword = async (plainPassword) => {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
};

const comparePassword = async (plainPassword, storedPassword) => {
  if (!storedPassword) return false;
  if (isPasswordHashed(storedPassword)) {
    return bcrypt.compare(plainPassword, storedPassword);
  }
  return storedPassword === plainPassword;
};

module.exports = {
  hashPassword,
  comparePassword,
  isPasswordHashed,
};
