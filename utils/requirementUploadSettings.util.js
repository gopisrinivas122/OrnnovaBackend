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
    const manualProfileUploadEnabled = getManualProfileUploadEnabled(requirement, userId);
    return {
      ...plain,
      manualProfileUploadEnabled,
      profileUploadEnabled: manualProfileUploadEnabled,
    };
  });
}

module.exports = {
  toUploadSettingsEntries,
  sanitizeUserUploadSettings,
  getManualProfileUploadEnabled,
  getProfileUploadEnabled,
  setProfileUploadEnabled,
  removeUserUploadSetting,
  attachProfileUploadEnabled,
};
