const NewRequirment = require('../models/Requirement');
const logger = require('./logger');

function normalizeId(value) {
  if (!value) return '';
  return value.toString();
}

function toUploadSettingsEntries(userUploadSettings) {
  if (!userUploadSettings) return [];
  if (!Array.isArray(userUploadSettings)) return [];

  return userUploadSettings.filter(
    (item) => item && typeof item === 'object' && !Array.isArray(item) && normalizeId(item.userId)
  );
}

function isFormDataObjectArrayString(value) {
  return typeof value === 'string' && /\[object Object\]/.test(value);
}

/**
 * Parse userUploadSettings from an edit payload.
 * Omit when absent so unrelated field updates cannot overwrite Stop/Start settings.
 * Reject malformed values before they reach Mongoose.
 */
function resolveUserUploadSettingsFromRequest(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return { action: 'omit' };
  }

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) return { action: 'omit' };
    if (isFormDataObjectArrayString(trimmed)) {
      return {
        action: 'reject',
        message: 'userUploadSettings must be an array of objects, not a string.',
      };
    }
    try {
      const parsed = JSON.parse(trimmed);
      return resolveUserUploadSettingsFromRequest(parsed);
    } catch (error) {
      return {
        action: 'reject',
        message: 'userUploadSettings must be a valid JSON array of objects.',
      };
    }
  }

  if (!Array.isArray(rawValue)) {
    return {
      action: 'reject',
      message: 'userUploadSettings must be an array of objects.',
    };
  }

  const sanitized = toUploadSettingsEntries(rawValue);
  if (rawValue.length > 0 && sanitized.length !== rawValue.length) {
    return {
      action: 'reject',
      message: 'userUploadSettings entries must be objects with a userId.',
    };
  }

  return { action: 'set', value: sanitized };
}

function applyUserUploadSettingsToUpdate(updateData, requestBody = {}) {
  if (!updateData || typeof updateData !== 'object') {
    return { ok: true };
  }

  if (!Object.prototype.hasOwnProperty.call(requestBody, 'userUploadSettings')) {
    delete updateData.userUploadSettings;
    return { ok: true };
  }

  const resolved = resolveUserUploadSettingsFromRequest(requestBody.userUploadSettings);
  if (resolved.action === 'omit') {
    delete updateData.userUploadSettings;
    return { ok: true };
  }
  if (resolved.action === 'reject') {
    delete updateData.userUploadSettings;
    return { ok: false, message: resolved.message };
  }

  updateData.userUploadSettings = resolved.value;
  return { ok: true };
}

function sanitizeUserUploadSettings(requirement) {
  if (!requirement) return;

  const sanitized = toUploadSettingsEntries(requirement.userUploadSettings);
  const rawLength = Array.isArray(requirement.userUploadSettings)
    ? requirement.userUploadSettings.length
    : 0;

  if (rawLength !== sanitized.length) {
    logger.warn('Removed invalid userUploadSettings entries', {
      requirementId: normalizeId(requirement._id),
      rawLength,
      sanitizedLength: sanitized.length,
    });
  }

  requirement.userUploadSettings = sanitized;
}

function getManualProfileUploadEnabled(requirement, userId) {
  if (!requirement || !userId) return true;

  const uid = normalizeId(userId);
  const settings = toUploadSettingsEntries(requirement.userUploadSettings);
  const entry = settings.find((item) => normalizeId(item.userId) === uid);

  if (!entry) return true;

  if (typeof entry.manuallyStopped === 'boolean') {
    return !entry.manuallyStopped;
  }

  if (typeof entry.profileUploadEnabled === 'boolean') {
    return entry.profileUploadEnabled;
  }

  return true;
}

function getProfileUploadEnabled(requirement, userId) {
  return getManualProfileUploadEnabled(requirement, userId);
}

/**
 * Display + API fields for per-user upload Stop/Start (employee + requirement).
 * Preserves manualProfileUploadEnabled from DB; effective fields drive UI badge/action.
 */
function computeUploadDisplayState(requirement, userId, currentlyAssigned) {
  const manualProfileUploadEnabled = getManualProfileUploadEnabled(requirement, userId);
  const assigned = Boolean(currentlyAssigned);

  if (!assigned) {
    return {
      currentlyAssigned: false,
      manualProfileUploadEnabled,
      effectiveProfileUploadEnabled: false,
      profileUploadEnabled: false,
      uploadAction: 'stop',
    };
  }

  return {
    currentlyAssigned: true,
    manualProfileUploadEnabled,
    effectiveProfileUploadEnabled: manualProfileUploadEnabled,
    profileUploadEnabled: manualProfileUploadEnabled,
    uploadAction: manualProfileUploadEnabled ? 'stop' : 'start',
  };
}

async function setProfileUploadEnabled(requirementId, userId, enabled) {
  const reqId = normalizeId(requirementId);
  const uid = normalizeId(userId);
  const enabledValue = Boolean(enabled);

  const requirement = await NewRequirment.findById(reqId);
  if (!requirement) {
    return { ok: false, statusCode: 404, message: 'Requirement not found.' };
  }

  sanitizeUserUploadSettings(requirement);

  const settings = [...toUploadSettingsEntries(requirement.userUploadSettings)];
  const index = settings.findIndex((item) => normalizeId(item.userId) === uid);

  const nextEntry = {
    userId: uid,
    profileUploadEnabled: enabledValue,
    manuallyStopped: !enabledValue,
  };

  if (index >= 0) {
    settings[index] = { ...settings[index], ...nextEntry };
  } else {
    settings.push(nextEntry);
  }

  requirement.userUploadSettings = settings;
  await requirement.save();

  return {
    ok: true,
    requirement,
    profileUploadEnabled: enabledValue,
    manualProfileUploadEnabled: enabledValue,
    manuallyStopped: !enabledValue,
  };
}

async function removeUserUploadSetting(requirementId, userId) {
  const reqId = normalizeId(requirementId);
  const uid = normalizeId(userId);

  await NewRequirment.updateOne(
    { _id: reqId },
    { $pull: { userUploadSettings: { userId: uid } } },
  );
}

function attachProfileUploadEnabled(requirement, users = []) {
  return users.map((user) => {
    const plain = user?.toObject ? user.toObject() : { ...user };
    const userId = normalizeId(plain._id || plain.userId);
    return {
      ...plain,
      ...computeUploadDisplayState(requirement, userId, true),
    };
  });
}

module.exports = {
  toUploadSettingsEntries,
  sanitizeUserUploadSettings,
  resolveUserUploadSettingsFromRequest,
  applyUserUploadSettingsToUpdate,
  getManualProfileUploadEnabled,
  getProfileUploadEnabled,
  computeUploadDisplayState,
  setProfileUploadEnabled,
  removeUserUploadSetting,
  attachProfileUploadEnabled,
};
