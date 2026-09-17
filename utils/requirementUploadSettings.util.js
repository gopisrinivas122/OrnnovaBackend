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
    (item) => item && typeof item === 'object' && normalizeId(item.userId)
  );
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

function getProfileUploadEnabled(requirement, userId) {
  if (!requirement || !userId) return true;

  const uid = normalizeId(userId);
  const settings = toUploadSettingsEntries(requirement.userUploadSettings);
  const entry = settings.find((item) => normalizeId(item.userId) === uid);

  if (!entry || typeof entry.profileUploadEnabled !== 'boolean') {
    return true;
  }

  return entry.profileUploadEnabled;
}

async function setProfileUploadEnabled(requirementId, userId, enabled, options = {}) {
  const reqId = normalizeId(requirementId);
  const uid = normalizeId(userId);
  const isManualChange = Boolean(options.isManualChange);
  const joinedCount = Number(options.joinedCount);
  const positionLimit = Number(options.positionLimit);

  const requirement = await NewRequirment.findById(reqId);
  if (!requirement) {
    return { ok: false, statusCode: 404, message: 'Requirement not found.' };
  }

  sanitizeUserUploadSettings(requirement);

  const settings = [...toUploadSettingsEntries(requirement.userUploadSettings)];
  const index = settings.findIndex((item) => normalizeId(item.userId) === uid);
  const enabledValue = Boolean(enabled);

  let positionLimitOverride = index >= 0
    ? Boolean(settings[index].positionLimitOverride)
    : false;

  if (isManualChange) {
    if (enabledValue) {
      const limit = Number.isFinite(positionLimit) && positionLimit > 0
        ? positionLimit
        : Number(requirement.numberOfPositions) || 1;
      const joined = Number.isFinite(joinedCount)
        ? joinedCount
        : null;
      positionLimitOverride = joined != null ? joined >= limit : false;
    } else {
      positionLimitOverride = false;
    }
  } else if (!enabledValue) {
    positionLimitOverride = false;
  }

  const nextEntry = {
    userId: uid,
    profileUploadEnabled: enabledValue,
    positionLimitOverride,
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
    positionLimitOverride,
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
      profileUploadEnabled: getProfileUploadEnabled(requirement, userId),
    };
  });
}

module.exports = {
  toUploadSettingsEntries,
  sanitizeUserUploadSettings,
  getProfileUploadEnabled,
  setProfileUploadEnabled,
  removeUserUploadSetting,
  attachProfileUploadEnabled,
};
