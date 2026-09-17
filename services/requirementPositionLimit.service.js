const NewUser = require('../models/User');
const NewRequirment = require('../models/Requirement');
const CandidateModel = require('../models/Candidate');
const { getLatestStatus } = require('../utils/candidateStatusMap');
const { buildCandidateReqIdValues } = require('../utils/requirementCandidateCounts');
const {
  toUploadSettingsEntries,
  sanitizeUserUploadSettings,
} = require('../utils/requirementUploadSettings.util');
const logger = require('../utils/logger');

function normalizeId(value) {
  if (!value) return '';
  return value.toString();
}

function getPositionLimit(requirement) {
  const positions = Number(requirement?.numberOfPositions);
  return Number.isFinite(positions) && positions > 0 ? positions : 1;
}

async function countJoinedCandidates(requirement) {
  if (!requirement?._id) return 0;

  const reqIdValues = buildCandidateReqIdValues(requirement._id, requirement);
  if (!reqIdValues.length) return 0;

  const docs = await CandidateModel.find({ reqId: { $in: reqIdValues } }).select('candidates').lean();
  let joinedCount = 0;

  docs.forEach((doc) => {
    (doc.candidates || []).forEach((candidate) => {
      if (getLatestStatus(candidate) === 'Joined') {
        joinedCount += 1;
      }
    });
  });

  return joinedCount;
}

async function getAssignedUserIds(requirementId) {
  const reqId = normalizeId(requirementId);
  if (!reqId) return [];

  const users = await NewUser.find({ Requirements: reqId }).select('_id').lean();
  return users.map((user) => normalizeId(user._id)).filter(Boolean);
}

async function stopAssignedUsersUpload(requirementId, userIds, { respectManualOverride = false } = {}) {
  const reqId = normalizeId(requirementId);
  const targetIds = [...new Set((userIds || []).map(normalizeId).filter(Boolean))];
  if (!reqId || !targetIds.length) return { changed: 0 };

  const requirement = await NewRequirment.findById(reqId);
  if (!requirement) return { changed: 0 };

  sanitizeUserUploadSettings(requirement);
  const settings = [...toUploadSettingsEntries(requirement.userUploadSettings)];
  let changed = 0;

  targetIds.forEach((uid) => {
    const index = settings.findIndex((item) => normalizeId(item.userId) === uid);
    const existing = index >= 0 ? settings[index] : null;

    if (
      respectManualOverride
      && existing?.positionLimitOverride
      && existing.profileUploadEnabled === true
    ) {
      return;
    }

    if (existing?.profileUploadEnabled === false && !existing?.positionLimitOverride) {
      return;
    }

    const nextEntry = {
      userId: uid,
      profileUploadEnabled: false,
      positionLimitOverride: false,
    };

    if (index >= 0) {
      settings[index] = { ...existing, ...nextEntry };
    } else {
      settings.push(nextEntry);
    }
    changed += 1;
  });

  if (!changed) return { changed: 0 };

  requirement.userUploadSettings = settings;
  await requirement.save();

  logger.info('Applied position-limit upload stop', {
    requirementId: reqId,
    userIds: targetIds,
    respectManualOverride,
    changed,
  });

  return { changed };
}

async function applyPositionLimitIfReached(requirementId, options = {}) {
  const reqId = normalizeId(requirementId);
  if (!reqId) return { applied: false };

  const requirement = await NewRequirment.findById(reqId);
  if (!requirement) return { applied: false };

  const joinedCount = await countJoinedCandidates(requirement);
  const positionLimit = getPositionLimit(requirement);

  if (joinedCount < positionLimit) {
    return { applied: false, joinedCount, positionLimit };
  }

  const userIds = options.onlyUserIds?.length
    ? options.onlyUserIds.map(normalizeId).filter(Boolean)
    : await getAssignedUserIds(reqId);

  const result = await stopAssignedUsersUpload(reqId, userIds, {
    respectManualOverride: Boolean(options.respectManualOverride),
  });

  return {
    applied: result.changed > 0,
    joinedCount,
    positionLimit,
    changed: result.changed,
  };
}

async function handleJoinedStatusUpdate(requirementId) {
  return applyPositionLimitIfReached(requirementId, {
    respectManualOverride: true,
  });
}

async function handleNewUserAssignment(requirementId, userId) {
  const reqId = normalizeId(requirementId);
  const uid = normalizeId(userId);
  if (!reqId || !uid) return { applied: false };

  const requirement = await NewRequirment.findById(reqId);
  if (!requirement) return { applied: false };

  const joinedCount = await countJoinedCandidates(requirement);
  const positionLimit = getPositionLimit(requirement);

  if (joinedCount < positionLimit) {
    return { applied: false, joinedCount, positionLimit };
  }

  const result = await stopAssignedUsersUpload(reqId, [uid], {
    respectManualOverride: false,
  });

  return {
    applied: result.changed > 0,
    joinedCount,
    positionLimit,
    changed: result.changed,
  };
}

module.exports = {
  countJoinedCandidates,
  getAssignedUserIds,
  stopAssignedUsersUpload,
  applyPositionLimitIfReached,
  handleJoinedStatusUpdate,
  handleNewUserAssignment,
};
