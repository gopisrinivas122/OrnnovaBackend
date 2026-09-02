const REQUIREMENT_TYPE_OPTIONS = [
  'High',
  'Medium',
  'Low',
  'On-Hold-Internal',
  'On Hold- Customer',
  'Fulfilled',
  'Closed',
  'Reopned',
];

const LEGACY_TYPE_MAP = {
  hot: 'High',
  warm: 'Medium',
  cold: 'Low',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  hold: 'On-Hold-Internal',
  Hold: 'On-Hold-Internal',
  cancel: 'Closed',
  Cancel: 'Closed',
  closed: 'Closed',
};

const BLOCKED_REQUIREMENT_TYPES = new Set([
  'On-Hold-Internal',
  'On Hold- Customer',
  'Fulfilled',
  'Closed',
  'Hold',
  'Cancel',
]);

const SORT_ORDER = {
  High: 1,
  Medium: 2,
  Low: 3,
  'On-Hold-Internal': 4,
  'On Hold- Customer': 5,
  Fulfilled: 6,
  Closed: 7,
  Reopned: 8,
  Hold: 9,
  Cancel: 10,
};

function normalizeRequirementType(type) {
  const raw = String(type || '').trim();
  if (!raw) return '';
  return LEGACY_TYPE_MAP[raw] || LEGACY_TYPE_MAP[raw.toLowerCase()] || raw;
}

function isValidRequirementType(type) {
  return REQUIREMENT_TYPE_OPTIONS.includes(normalizeRequirementType(type));
}

function isRequirementWorkBlocked(type) {
  const normalized = normalizeRequirementType(type);
  return BLOCKED_REQUIREMENT_TYPES.has(normalized);
}

function getRequirementTypeSortIndex(type) {
  return SORT_ORDER[normalizeRequirementType(type)] || 99;
}

function getUploadedDateOnReopen(previousType, nextType) {
  if (normalizeRequirementType(previousType) !== 'Reopned' && normalizeRequirementType(nextType) === 'Reopned') {
    return new Date();
  }
  return null;
}

module.exports = {
  REQUIREMENT_TYPE_OPTIONS,
  normalizeRequirementType,
  isValidRequirementType,
  isRequirementWorkBlocked,
  getRequirementTypeSortIndex,
  getUploadedDateOnReopen,
};
