const NewUser = require('../models/User');
const NewRequirment = require('../models/Requirement');
const CandidateModel = require('../models/Candidate');
const { isActiveUser } = require('../utils/userStatus');
const { getProfileUploadEnabled } = require('../utils/requirementUploadSettings.util');
const { isRequirementExcludedForUser } = require('../utils/teamLeadRequirements');
const logger = require('../utils/logger');
const {
  attachCreatorInfo,
  buildCreatorInfoMapForRequirements,
} = require('../utils/requirementCreator');

const CLAIM_STATUS = {
  ASSIGNED: 'Assigned',
  CLAIMED: 'Claimed',
};

function normalizeId(value) {
  return value ? String(value) : '';
}

function toClaimEntries(claimedBy) {
  if (!claimedBy) return [];
  if (!Array.isArray(claimedBy)) return [];

  return claimedBy.filter((claim) => claim && normalizeId(claim.userId));
}

function sanitizeRequirementClaimLists(requirement) {
  if (!requirement) return;

  const sanitized = toClaimEntries(requirement.claimedBy);
  const rawLength = Array.isArray(requirement.claimedBy) ? requirement.claimedBy.length : 0;

  if (rawLength !== sanitized.length) {
    logger.warn('Removed invalid claimedBy entries while processing requirement claim state', {
      requirementId: normalizeId(requirement._id),
      rawLength,
      sanitizedLength: sanitized.length,
    });
  }

  requirement.claimedBy = sanitized;

  const currentUserId = normalizeId(requirement.currentClaimedBy?.userId);
  if (requirement.currentClaimedBy && !currentUserId) {
    requirement.currentClaimedBy = undefined;
  }
}

function resolveActorId(req, fallbackUserId) {
  return normalizeId(req?.user?.id || fallbackUserId);
}

function resolveActorRole(req) {
  return req?.user?.role || '';
}

function getCreatedBy(requirement) {
  return normalizeId(requirement?.createdBy || requirement?.uploadedBy);
}

function getUserClaim(requirement, userId) {
  if (!requirement || !userId) return null;

  const uid = normalizeId(userId);
  const current = requirement.currentClaimedBy;
  if (current?.userId && normalizeId(current.userId) === uid) {
    return {
      userId: uid,
      claimedDate: current.claimedDate || null,
    };
  }

  const listed = toClaimEntries(requirement.claimedBy).find(
    (claim) => normalizeId(claim.userId) === uid
  );
  if (!listed) return null;

  return {
    userId: uid,
    claimedDate: listed.claimedDate || null,
  };
}

function hasUserClaimed(requirement, userId) {
  return Boolean(getUserClaim(requirement, userId));
}

function getCurrentClaim(requirement) {
  if (!requirement) return null;

  const current = requirement.currentClaimedBy;
  if (current?.userId) {
    return {
      userId: normalizeId(current.userId),
      claimedDate: current.claimedDate || null,
    };
  }

  const firstListed = toClaimEntries(requirement.claimedBy)[0];
  if (!firstListed?.userId) return null;

  return {
    userId: normalizeId(firstListed.userId),
    claimedDate: firstListed.claimedDate || null,
  };
}

function getClaimStatus(requirement) {
  const hasAnyClaim = toClaimEntries(requirement?.claimedBy).length > 0
    || Boolean(requirement?.currentClaimedBy?.userId);
  if (requirement?.claimStatus === CLAIM_STATUS.ASSIGNED && !hasAnyClaim) {
    return CLAIM_STATUS.ASSIGNED;
  }
  return hasAnyClaim ? CLAIM_STATUS.CLAIMED : CLAIM_STATUS.ASSIGNED;
}

async function getCandidateCountForUserOnRequirement(reqId, userId) {
  if (!reqId || !userId) return 0;

  const docs = await CandidateModel.find({
    reqId: normalizeId(reqId),
    recruiterId: normalizeId(userId),
  }).select('candidates').lean();

  return docs.reduce((total, doc) => total + (Array.isArray(doc.candidates) ? doc.candidates.length : 0), 0);
}

async function getTotalCandidateCountForRequirement(reqId) {
  if (!reqId) return 0;

  const docs = await CandidateModel.find({ reqId: normalizeId(reqId) }).select('candidates').lean();
  return docs.reduce((total, doc) => total + (Array.isArray(doc.candidates) ? doc.candidates.length : 0), 0);
}

function isUserAssignedToRequirement(user, requirementId) {
  if (!user) return false;
  const reqId = normalizeId(requirementId);
  return (user.Requirements || []).some((id) => normalizeId(id) === reqId);
}

async function loadActor(userId, req) {
  const actorId = resolveActorId(req, userId);
  if (!actorId) return null;

  if (req?.user?.id && normalizeId(req.user.id) === actorId) {
    const user = await NewUser.findById(actorId);
    if (user) return user;
  }

  return NewUser.findById(actorId);
}

async function canUserViewRequirement(user, requirement) {
  if (!user || !requirement) return false;

  const userId = user._id.toString();
  const reqId = requirement._id.toString();

  if (user.UserType === 'Admin') return true;

  if (user.UserType === 'TeamLead') {
    if (isRequirementExcludedForUser(user, reqId)) return false;
    return getCreatedBy(requirement) === userId || isUserAssignedToRequirement(user, reqId);
  }

  if (user.UserType === 'User') {
    return isUserAssignedToRequirement(user, reqId);
  }

  return false;
}

async function canUserEditRequirement(user, requirement) {
  if (!user || !requirement) return false;
  if (user.UserType === 'Admin') return true;
  if (user.UserType === 'TeamLead') {
    return getCreatedBy(requirement) === user._id.toString();
  }
  return false;
}

async function canUserClaimRequirement(user, requirement) {
  if (!user || !requirement || !isActiveUser(user)) return false;
  if (user.UserType === 'Admin') return false;

  const reqId = requirement._id.toString();
  const userId = user._id.toString();

  if (hasUserClaimed(requirement, userId)) return false;

  if (user.UserType === 'User') {
    return isUserAssignedToRequirement(user, reqId);
  }

  if (user.UserType === 'TeamLead') {
    return getCreatedBy(requirement) === userId || isUserAssignedToRequirement(user, reqId);
  }

  return false;
}

async function canUserUnclaimRequirement(user, requirement) {
  if (!user || !requirement) return false;
  if (user.UserType === 'Admin') return false;

  const userId = user._id.toString();
  if (!hasUserClaimed(requirement, userId)) return false;

  const candidateCount = await getCandidateCountForUserOnRequirement(requirement._id, userId);
  return candidateCount === 0;
}

async function canUserAssignRequirement(user, requirement) {
  if (!user || !requirement || !isActiveUser(user) || user.UserType !== 'TeamLead') {
    return false;
  }

  const userId = user._id.toString();
  const reqId = requirement._id.toString();
  const isCreator = getCreatedBy(requirement) === userId;
  const isAssigned = isUserAssignedToRequirement(user, reqId);

  if (isCreator) return true;
  if (isAssigned && hasUserClaimed(requirement, userId)) return true;
  return false;
}

async function canUserUploadToRequirement(user, requirement) {
  if (!user || !requirement || !isActiveUser(user)) return false;
  if (user.UserType === 'Admin') return false;

  const userId = user._id.toString();
  if (!hasUserClaimed(requirement, userId)) return false;
  return getProfileUploadEnabled(requirement, userId);
}

function getWorkflowBadge(requirement, user, { canClaim, canUpload }) {
  if (user && canUpload) return 'Claimed';
  if (user && canClaim) return 'Pending Claim';
  if ((requirement?.assignedMembers || []).length > 0 && getClaimStatus(requirement) !== CLAIM_STATUS.CLAIMED) {
    return 'Assigned';
  }
  if (getClaimStatus(requirement) === CLAIM_STATUS.CLAIMED) return 'Claimed';
  return 'Pending Claim';
}

async function enrichRequirementWorkflow(requirement, user, options = {}) {
  const plain = requirement?.toObject ? requirement.toObject() : { ...requirement };
  const userId = user?._id?.toString() || '';
  const currentClaim = userId ? getUserClaim(plain, userId) : getCurrentClaim(plain);
  const claimStatus = getClaimStatus(plain);
  const candidateCount = userId
    ? await getCandidateCountForUserOnRequirement(plain._id, userId)
    : await getTotalCandidateCountForRequirement(plain._id);

  const [
    canClaim,
    canUnclaim,
    canUpload,
    canEdit,
    canAssign,
  ] = user
    ? await Promise.all([
      canUserClaimRequirement(user, plain),
      canUserUnclaimRequirement(user, plain),
      canUserUploadToRequirement(user, plain),
      canUserEditRequirement(user, plain),
      canUserAssignRequirement(user, plain),
    ])
    : [false, false, false, false, false];

  const workflowBadge = getWorkflowBadge(plain, user, { canClaim, canUpload });
  const claimedAt = currentClaim?.claimedDate || plain.claimedAt || null;
  const hasClaimed = userId ? hasUserClaimed(plain, userId) : false;
  const profileUploadEnabled = userId ? getProfileUploadEnabled(plain, userId) : true;
  const uploadStopped = hasClaimed && !profileUploadEnabled;

  return {
    ...plain,
    createdBy: getCreatedBy(plain),
    claimStatus,
    currentClaimedBy: currentClaim,
    claimedAt,
    candidateCount,
    workflow: {
      claimStatus,
      currentClaimedBy: currentClaim,
      candidateCount,
      canClaim,
      canUnclaim,
      canUpload,
      canEdit,
      canAssign,
      workflowBadge,
      profileUploadEnabled,
      uploadDisabledMessage: canUpload
        ? ''
        : uploadStopped
          ? 'Profile upload is currently stopped for you for this requirement.'
          : 'Claim this requirement before uploading profiles or taking candidate actions.',
      assignDisabledMessage: 'Claim this requirement before assigning it to your team members.',
    },
  };
}

async function enrichRequirementsWorkflow(requirements, user) {
  const enriched = await Promise.all(
    (requirements || []).map((req) => enrichRequirementWorkflow(req, user))
  );

  if (!enriched.length) return enriched;

  const creatorInfoMap = await buildCreatorInfoMapForRequirements(enriched);
  return enriched.map((req) => attachCreatorInfo(req, creatorInfoMap));
}

async function claimRequirement(requirementId, req, bodyUserId) {
  const actor = await loadActor(bodyUserId, req);
  if (!actor) {
    return { statusCode: 401, payload: { status: 'Fail', msg: 'User not found.' } };
  }

  if (actor.UserType === 'Admin') {
    return { statusCode: 403, payload: { status: 'Fail', msg: 'Admin cannot claim requirements.' } };
  }

  const requirement = await NewRequirment.findById(requirementId);
  if (!requirement) {
    return { statusCode: 404, payload: { status: 'Fail', msg: 'Requirement not found.' } };
  }

  if (!(await canUserViewRequirement(actor, requirement))) {
    return { statusCode: 403, payload: { status: 'Fail', msg: 'You do not have access to this requirement.' } };
  }

  sanitizeRequirementClaimLists(requirement);

  if (!(await canUserClaimRequirement(actor, requirement))) {
    return { statusCode: 403, payload: { status: 'Fail', msg: 'You cannot claim this requirement.' } };
  }

  const userId = actor._id.toString();
  const claimedDate = new Date();
  const currentClaim = { userId, claimedDate };

  const alreadyListed = requirement.claimedBy.some((claim) => normalizeId(claim.userId) === userId);
  if (!alreadyListed) {
    requirement.claimedBy.push(currentClaim);
  }

  requirement.currentClaimedBy = currentClaim;
  requirement.claimStatus = CLAIM_STATUS.CLAIMED;
  requirement.claimedAt = claimedDate;
  if (!requirement.createdBy) requirement.createdBy = getCreatedBy(requirement);

  try {
    await requirement.save();
  } catch (error) {
    logger.error('claimRequirement save failed', {
      requirementId: normalizeId(requirement._id),
      userId,
      errorName: error.name,
      message: error.message,
      stack: error.stack,
    });

    if (error.name === 'ValidationError') {
      return {
        statusCode: 400,
        payload: { status: 'Fail', msg: error.message },
      };
    }

    throw error;
  }

  return {
    statusCode: 200,
    payload: { status: 'Success', msg: 'Requirement claimed successfully.' },
  };
}

async function unclaimRequirement(requirementId, req, bodyUserId) {
  const actor = await loadActor(bodyUserId, req);
  if (!actor) {
    return { statusCode: 401, payload: { status: 'Fail', msg: 'User not found.' } };
  }

  if (actor.UserType === 'Admin') {
    return { statusCode: 403, payload: { status: 'Fail', msg: 'Admin cannot unclaim requirements.' } };
  }

  const requirement = await NewRequirment.findById(requirementId);
  if (!requirement) {
    return { statusCode: 404, payload: { status: 'Fail', msg: 'Requirement not found.' } };
  }

  const userId = actor._id.toString();

  sanitizeRequirementClaimLists(requirement);

  if (!hasUserClaimed(requirement, userId)) {
    return { statusCode: 403, payload: { status: 'Fail', msg: 'You have not claimed this requirement.' } };
  }

  const candidateCount = await getCandidateCountForUserOnRequirement(requirement._id, userId);
  if (candidateCount > 0) {
    return {
      statusCode: 403,
      payload: { status: 'Fail', msg: 'You cannot unclaim because candidate profiles have already been uploaded.' },
    };
  }

  requirement.claimedBy = toClaimEntries(requirement.claimedBy).filter(
    (claim) => normalizeId(claim.userId) !== userId
  );

  if (normalizeId(requirement.currentClaimedBy?.userId) === userId) {
    const nextClaim = requirement.claimedBy[0];
    requirement.currentClaimedBy = nextClaim
      ? { userId: normalizeId(nextClaim.userId), claimedDate: nextClaim.claimedDate || new Date() }
      : undefined;
  }

  requirement.claimStatus = requirement.claimedBy.length
    ? CLAIM_STATUS.CLAIMED
    : CLAIM_STATUS.ASSIGNED;
  if (!requirement.claimedBy.length) {
    requirement.claimedAt = undefined;
  }
  await requirement.save();

  return {
    statusCode: 200,
    payload: { status: 'Success', msg: 'Requirement unclaimed successfully.' },
  };
}

async function validateUploadAllowed(requirementId, req, recruiterId) {
  const actor = await loadActor(recruiterId, req);
  if (!actor) {
    return { allowed: false, statusCode: 401, message: 'User not found.' };
  }

  if (actor.UserType === 'Admin') {
    return { allowed: false, statusCode: 403, message: 'Admin cannot upload candidate profiles.' };
  }

  const requirement = await NewRequirment.findById(requirementId);
  if (!requirement) {
    return { allowed: false, statusCode: 404, message: 'Requirement not found.' };
  }

  if (!(await canUserUploadToRequirement(actor, requirement))) {
    const userId = actor._id.toString();
    const hasClaimed = hasUserClaimed(requirement, userId);
    const profileUploadEnabled = getProfileUploadEnabled(requirement, userId);

    if (hasClaimed && !profileUploadEnabled) {
      return {
        allowed: false,
        statusCode: 403,
        message: 'Profile upload is currently stopped for you for this requirement.',
      };
    }

    return {
      allowed: false,
      statusCode: 403,
      message: 'Please claim this requirement before uploading candidate profiles.',
    };
  }

  return { allowed: true, actor, requirement };
}

async function syncRequirementCandidateCount(requirementId) {
  const total = await getTotalCandidateCountForRequirement(requirementId);
  await NewRequirment.findByIdAndUpdate(requirementId, { candidateCount: total });
  return total;
}

module.exports = {
  CLAIM_STATUS,
  normalizeId,
  toClaimEntries,
  sanitizeRequirementClaimLists,
  resolveActorId,
  resolveActorRole,
  getCreatedBy,
  getUserClaim,
  hasUserClaimed,
  getCurrentClaim,
  getClaimStatus,
  getCandidateCountForUserOnRequirement,
  getTotalCandidateCountForRequirement,
  isUserAssignedToRequirement,
  canUserViewRequirement,
  canUserEditRequirement,
  canUserClaimRequirement,
  canUserUnclaimRequirement,
  canUserAssignRequirement,
  canUserUploadToRequirement,
  enrichRequirementWorkflow,
  enrichRequirementsWorkflow,
  claimRequirement,
  unclaimRequirement,
  validateUploadAllowed,
  syncRequirementCandidateCount,
};
