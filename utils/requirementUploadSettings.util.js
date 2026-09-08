const NewRequirment = require('../models/Requirement');

function normalizeId(value) {
  if (!value) return '';
  return value.toString();
}

function getProfileUploadEnabled(requirement, userId) {
  if (!requirement || !userId) return true;

  const uid = normalizeId(userId);
  const settings = requirement.userUploadSettings || [];
  const entry = settings.find((item) => normalizeId(item.userId) === uid);

  if (!entry || typeof entry.profileUploadEnabled !== 'boolean') {
    return true;
  }

  return entry.profileUploadEnabled;
}

async function setProfileUploadEnabled(requirementId, userId, enabled) {
  const reqId = normalizeId(requirementId);
  const uid = normalizeId(userId);

  const requirement = await NewRequirment.findById(reqId);
  if (!requirement) {
    return { ok: false, statusCode: 404, message: 'Requirement not found.' };
  }

  const settings = [...(requirement.userUploadSettings || [])];
  const index = settings.findIndex((item) => normalizeId(item.userId) === uid);

  if (index >= 0) {
    settings[index] = { ...settings[index], userId: uid, profileUploadEnabled: Boolean(enabled) };
  } else {
    settings.push({ userId: uid, profileUploadEnabled: Boolean(enabled) });
  }

  requirement.userUploadSettings = settings;
  await requirement.save();

  return {
    ok: true,
    requirement,
    profileUploadEnabled: Boolean(enabled),
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
  getProfileUploadEnabled,
  setProfileUploadEnabled,
  removeUserUploadSetting,
  attachProfileUploadEnabled,
};
