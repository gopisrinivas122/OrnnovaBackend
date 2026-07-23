const nodemailer = require('nodemailer');
const { EMAIL, PASSWORD } = require('./env');
const logger = require('../utils/logger');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL,
    pass: PASSWORD,
  },
});

const sendEmailSafely = async (mailOptions, { throwOnError = false } = {}) => {
  try {
    await transporter.sendMail(mailOptions);
    logger.info('Email sent successfully to:', mailOptions.to);
    return true;
  } catch (emailError) {
    logger.error('Email sending failed:', emailError.message);
    if (throwOnError) {
      throw emailError;
    }
    return false;
  }
};

module.exports = { transporter, sendEmailSafely };
