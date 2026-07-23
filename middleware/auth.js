const { verifyAccessToken } = require('../utils/authToken');
const { JWT_SECRET } = require('../config/env');

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

const authMiddleware = (req, res, next) => {
  if (isPublicRoute(req)) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ status: 'Failed', msg: 'Authentication required. Please sign in again.' });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      name: payload.name,
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
  if (!roles.includes(req.user.role)) {
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
