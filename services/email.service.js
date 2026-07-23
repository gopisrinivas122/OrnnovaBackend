const { sendEmailSafely } = require('../config/mail');
const { EMAIL } = require('../config/env');

const sendClientAssignedEmail = (user) => {
  return sendEmailSafely({
    from: EMAIL,
    to: user.Email,
    subject: 'Client Assigned To You',
    text: `Dear ${user.EmployeeName},\n\nA new client has been assigned to you.\n\n Check Here: https://ornnova.com/HR/`,
  });
};

const sendRequirementAssignedEmail = (user) => {
  return sendEmailSafely({
    from: EMAIL,
    to: user.Email,
    subject: 'Requirement Assigned To You',
    text: `Dear ${user.EmployeeName},\n\nA new requirement has been successfully assigned to you.\n\n Check Here: https://ornnova.com/HR/`,
  });
};

const sendPasswordResetEmail = (user, resetUrl) => {
  return sendEmailSafely({
    from: EMAIL,
    to: user.Email,
    subject: 'Reset Your ORNNOVA HR Password',
    text: `Dear ${user.EmployeeName},\n\nWe received a request to reset your password.\n\nReset your password using this link (valid for 1 hour):\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
  }, { throwOnError: true });
};

module.exports = { sendClientAssignedEmail, sendRequirementAssignedEmail, sendPasswordResetEmail };
