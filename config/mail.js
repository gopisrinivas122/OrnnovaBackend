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

const sendEmailSafely = async (mailOptions) => {
  try {
    await transporter.sendMail(mailOptions);
    logger.info('Email sent successfully to:', mailOptions.to);
  } catch (emailError) {
    logger.error('Email sending failed (non-blocking):', emailError.message);
  }
};

module.exports = { transporter, sendEmailSafely };
