const NewUser = require('../models/User');
const { verifyAccessToken } = require('../utils/authToken');
const { JWT_SECRET } = require('../config/env');
const { ACTIVE_STATUS, isSupportedUserType } = require('../utils/constants');
const { authenticateDocumentPreviewTicket } = require('../services/candidateDocumentUpdate.service');

const PUBLIC_ROUTE_RULES = [
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/login' },
  { method: 'POST', path: '/sendpasswordlink' },
];

const PUBLIC_ROUTE_PATTERNS = [
  { method: 'GET', pattern: /^\/ResetPasswordpage\/[^/]+\/[^/]+$/ },
  { method: 'POST', pattern: /^\/Changepassword\/[^/]+\/[^/]+$/ },
];

const isPublicRoute = (req) => {
  const method = req.method.toUpperCase();
  const path = req.path || req.url.split('?')[0];

  if (PUBLIC_ROUTE_RULES.some((rule) => rule.method === method && rule.path === path)) {
    return true;
  }

  return PUBLIC_ROUTE_PATTERNS.some(
    (rule) => rule.method === method && rule.pattern.test(path)
  );
};

const authMiddleware = async (req, res, next) => {
  if (isPublicRoute(req)) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    try {
      const ticketUser = await authenticateDocumentPreviewTicket(req);
      if (ticketUser) {
        req.user = ticketUser;
        return next();
      }
    } catch (error) {
      return res.status(401).json({ status: 'Failed', msg: 'Authentication required. Please sign in again.' });
    }
    return res.status(401).json({ status: 'Failed', msg: 'Authentication required. Please sign in again.' });
  }

  try {
    const payload = verifyAccessToken(token);
    const user = await NewUser.findById(payload.id).select('_id Email UserType Status EmployeeName').lean();
    if (!user || user.Status !== ACTIVE_STATUS) {
      return res.status(401).json({ status: 'Failed', msg: 'Session expired. Please sign in again.' });
    }
    if (!isSupportedUserType(user.UserType)) {
      return res.status(403).json({ status: 'Failed', msg: 'You do not have permission to perform this action.' });
    }
    req.user = {
      id: String(user._id),
      email: user.Email,
      role: user.UserType,
      name: user.EmployeeName || '',
    };
    return next();
  } catch (error) {
    return res.status(401).json({ status: 'Failed', msg: 'Session expired. Please sign in again.' });
  }
};

const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ status: 'Failed', msg: 'Authentication required.' });
  }
  if (!roles.includes(req.user.role) || !isSupportedUserType(req.user.role)) {
    return res.status(403).json({ status: 'Failed', msg: 'You do not have permission to perform this action.' });
  }
  return next();
};

module.exports = {
  JWT_SECRET,
  authMiddleware,
  authorizeRoles,
  isPublicRoute,
};
