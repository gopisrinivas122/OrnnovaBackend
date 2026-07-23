const successResponse = (res, data, statusCode = 200) => {
  if (res.headersSent) return;
  return res.status(statusCode).json(data);
};

const errorResponse = (res, message, statusCode = 500, extra = {}) => {
  if (res.headersSent) return;
  return res.status(statusCode).json({ status: 'Failed', msg: message, ...extra });
};

module.exports = { successResponse, errorResponse };
