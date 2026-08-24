const PRIORITY_VALUES = [1, 2, 3, 4, 5];

function canManageRequirementPriority(user) {
  return user?.UserType === 'Admin';
}

function normalizeRequirementPriority(priority) {
  if (priority === null || priority === undefined || priority === '') {
    return null;
  }

  const numeric = Number(priority);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 5) {
    return undefined;
  }

  return numeric;
}

function isValidRequirementPriority(priority) {
  return normalizeRequirementPriority(priority) !== undefined
    || priority === null
    || priority === undefined
    || priority === '';
}

module.exports = {
  PRIORITY_VALUES,
  canManageRequirementPriority,
  normalizeRequirementPriority,
  isValidRequirementPriority,
};
