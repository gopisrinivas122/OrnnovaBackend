const { ACTIVE_STATUS, INACTIVE_STATUS } = require('./constants');

const activeUserFilter = { Status: { $in: [ACTIVE_STATUS] } };

function isActiveUser(user) {
  if (!user) return false;
  return user.Status !== INACTIVE_STATUS;
}

module.exports = {
  ACTIVE_STATUS,
  INACTIVE_STATUS,
  activeUserFilter,
  isActiveUser,
};
