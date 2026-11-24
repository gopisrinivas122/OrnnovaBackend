const NewRequirment = require('../models/Requirement');
const { isValidObjectId } = require('../middleware/validateObjectId');
const { candidateOwnedByUser } = require('./candidateOwnership.util');
const {
  getTeamLeadClientContext,
  isRequirementVisibleToTeamLead,
  teamLeadOwnsRequirementClient,
} = require('./teamLeadRequirements');

function requirementAccessKeys(requirement) {
  const keys = new Set();
  if (requirement?._id) keys.add(String(requirement._id));
  const regId = requirement?.regId != null ? String(requirement.regId).trim() : '';
  if (regId) keys.add(regId);
  return keys;
}

function classifyTeamLeadRequirement(user, requirement, clientNames = []) {
  if (!isRequirementVisibleToTeamLead(user, requirement, 'all', clientNames)) return 'none';
  if (teamLeadOwnsRequirementClient(user, requirement, clientNames)) return 'full';
  return 'own';
}

function buildTeamLeadProfileAccess(user, requirements = [], clientNames = []) {
  const fullKeys = new Set();
  const ownKeys = new Set();

  (requirements || []).forEach((requirement) => {
    const level = classifyTeamLeadRequirement(user, requirement, clientNames);
    if (level === 'none') return;
    const target = level === 'full' ? fullKeys : ownKeys;
    requirementAccessKeys(requirement).forEach((key) => target.add(key));
  });

  return {
    fullKeys,
    ownKeys,
    actorId: String(user?._id || ''),
  };
}

function candidateRowVisibleToTeamLead(row, access) {
  const reqId = String(row?.reqId || '').trim();
  if (!reqId || !access) return false;
  const visible = access.fullKeys.has(reqId)
    || (
      access.ownKeys.has(reqId)
      && candidateOwnedByUser(row.candidate, row.recruiterIds, access.actorId)
    );
  if (!visible) return false;
  if (!access.restrictToRecruiterId) return true;
  return candidateOwnedByUser(row.candidate, row.recruiterIds, access.restrictToRecruiterId);
}

async function findRequirementByKey(reqId) {
  if (!reqId) return null;
  const raw = String(reqId).trim();
  if (!raw) return null;
  const orConditions = [{ regId: raw }];
  if (isValidObjectId(raw)) orConditions.push({ _id: raw });
  return NewRequirment.findOne({ $or: orConditions }).exec();
}

async function resolveTeamLeadRequirementAccess(user, requirement) {
  const { clientNames } = user
    ? await getTeamLeadClientContext(user)
    : { clientNames: [] };
  const level = classifyTeamLeadRequirement(user, requirement, clientNames);
  return {
    clientNames,
    level,
    canViewRequirement: level !== 'none',
    canUpdateStatus: level === 'full',
  };
}

async function resolveTeamLeadCandidateAccess(user, context) {
  const requirement = await findRequirementByKey(context?.reqId);
  const requirementAccess = await resolveTeamLeadRequirementAccess(user, requirement);
  const canView = requirementAccess.level === 'full'
    || (
      requirementAccess.level === 'own'
      && candidateOwnedByUser(context?.candidate, context?.docRecruiterIds, user?._id)
    );

  return {
    ...requirementAccess,
    requirement,
    canView,
  };
}

async function authorizeTeamLeadProfileStatusUpdate(user, context) {
  if (!user || user.UserType !== 'TeamLead') return { ok: true };
  const access = await resolveTeamLeadCandidateAccess(user, context);
  if (!access.canUpdateStatus) {
    return {
      ok: false,
      statusCode: 403,
      message: 'You do not have permission to update this profile status.',
    };
  }
  return { ok: true };
}

async function authorizeTeamLeadProfileView(user, context) {
  if (!user || user.UserType !== 'TeamLead') return { ok: true, canUpdateProfileStatus: true };
  const access = await resolveTeamLeadCandidateAccess(user, context);
  if (!access.canView) {
    return {
      ok: false,
      statusCode: 403,
      message: 'You do not have permission to view this source profile.',
    };
  }
  return { ok: true, canUpdateProfileStatus: access.canUpdateStatus };
}

module.exports = {
  requirementAccessKeys,
  classifyTeamLeadRequirement,
  buildTeamLeadProfileAccess,
  candidateRowVisibleToTeamLead,
  findRequirementByKey,
  resolveTeamLeadRequirementAccess,
  resolveTeamLeadCandidateAccess,
  authorizeTeamLeadProfileStatusUpdate,
  authorizeTeamLeadProfileView,
};
