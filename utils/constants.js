const EXISTING_USER_TYPES = ['Admin', 'TeamLead', 'User'];
const OFFER_WORKFLOW_USER_TYPES = ['HR'];
const USER_TYPES = [...EXISTING_USER_TYPES, ...OFFER_WORKFLOW_USER_TYPES];

function isSupportedUserType(role) {
  return USER_TYPES.includes(String(role || '').trim());
}

function isAdminOrHrRole(role) {
  const value = String(role || '').trim();
  return value === 'Admin' || value === 'HR';
}

module.exports = {
  EXISTING_USER_TYPES,
  OFFER_WORKFLOW_USER_TYPES,
  USER_TYPES,
  ACTIVE_STATUS: 'Active',
  INACTIVE_STATUS: 'InActive',
  isSupportedUserType,
  isAdminOrHrRole,
};
