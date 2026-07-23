const authService = require('../services/auth.service');

const sendError = (res, error) => res.status(error.status).json(error.body);

exports.login = async (req, res) => {
  const { Email, Password } = req.body;
  const result = await authService.login({ Email, Password });
  if (result.error) return sendError(res, result.error);
  return res.json(result.data);
};

exports.getLoggedInUserData = async (req, res) => {
  const result = await authService.getLoggedInUserData(req.params.email);
  if (result.error) return sendError(res, result.error);
  return res.json(result.data);
};

exports.sendPasswordLink = async (req, res) => {
  const frontendBaseUrl = req.body.frontendUrl || process.env.FRONTEND_URL || 'http://localhost:3000';
  const result = await authService.sendPasswordResetLink(req.body.Email || req.body.email, frontendBaseUrl);
  if (result.error) return sendError(res, result.error);
  return res.json(result.data);
};

exports.validateResetPasswordPage = async (req, res) => {
  const result = await authService.validateResetToken(req.params.id, req.params.token);
  if (result.error) return sendError(res, result.error);
  return res.json(result.data);
};

exports.changePassword = async (req, res) => {
  const { Password, password } = req.body;
  const result = await authService.changePassword(
    req.params.id,
    req.params.token,
    Password || password
  );
  if (result.error) return sendError(res, result.error);
  return res.json(result.data);
};
