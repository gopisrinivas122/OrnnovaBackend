const REQUIREMENT_TYPE_OPTIONS = ['High', 'Medium', 'Low', 'Hold', 'Cancel'];

const LEGACY_TYPE_MAP = {
  hot: 'High',
  warm: 'Medium',
  cold: 'Low',
  closed: 'Cancel',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  hold: 'Hold',
  cancel: 'Cancel',
};

const SORT_ORDER = {
  High: 1,
  Medium: 2,
  Low: 3,
  Hold: 4,
  Cancel: 5,
};

function normalizeRequirementType(type) {
  const raw = String(type || '').trim();
  if (!raw) return '';
  return LEGACY_TYPE_MAP[raw.toLowerCase()] || raw;
}

function isValidRequirementType(type) {
  return REQUIREMENT_TYPE_OPTIONS.includes(normalizeRequirementType(type));
}

function isRequirementWorkBlocked(type) {
  const normalized = normalizeRequirementType(type);
  return normalized === 'Hold' || normalized === 'Cancel';
}

function getRequirementTypeSortIndex(type) {
  return SORT_ORDER[normalizeRequirementType(type)] || 99;
}

module.exports = {
  REQUIREMENT_TYPE_OPTIONS,
  normalizeRequirementType,
  isValidRequirementType,
  isRequirementWorkBlocked,
  getRequirementTypeSortIndex,
};
