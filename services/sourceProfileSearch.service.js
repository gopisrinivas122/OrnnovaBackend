const CandidateModel = require('../models/Candidate');
const NewRequirment = require('../models/Requirement');
const NewUser = require('../models/User');
const { isValidObjectId } = require('../middleware/validateObjectId');
const { enrichRequirementsWithClientNames } = require('../utils/requirementClient');
const { candidateOwnedByUser } = require('../utils/candidateOwnership.util');
const { isRequirementVisibleToTeamLead } = require('../utils/teamLeadRequirements');
const { activeUserFilter } = require('../utils/userStatus');
const { loadCandidateDocumentContext } = require('./candidateDocumentUpdate.service');
const { serializeCandidateStatusHistory } = require('../utils/statusRemarks');
const {
  normalizeSourceProfileNameQuery,
  candidateMatchesSourceProfileName,
} = require('../utils/sourceProfileNameMatch');
const {
  flattenUploadedCandidates,
  buildRequirementMap,
  resolveUploaderIds,
  resolveClientNameForCandidateRow,
  buildUserMap,
  getAdminSourceProfiles,
} = require('./adminAnalytics.service');

function buildVisibleRequirementIdSet(requirements = []) {
  const ids = new Set();
  requirements.forEach((req) => {
    if (req?._id) ids.add(String(req._id));
    if (req?.regId != null && String(req.regId).trim() !== '') {
      ids.add(String(req.regId).trim());
    }
  });
  return ids;
}

function rowMatchesVisibleRequirement(row, visibleReqIds) {
  const reqId = String(row?.reqId || '').trim();
  return Boolean(reqId) && visibleReqIds.has(reqId);
}

function rowOwnedByAllowedRecruiters(row, allowedRecruiterIds) {
  const ownerIds = resolveUploaderIds(row);
  return ownerIds.some((id) => allowedRecruiterIds.has(String(id)));
}

function groupRowsByRecruiter(scopedRows, users, reqMap) {
  const recruiterIdToCandidates = {};

  scopedRows.forEach((row) => {
    const serialized = serializeCandidateStatusHistory(row.candidate);
    const recruiterIds = Array.isArray(serialized.recruiterId) && serialized.recruiterId.length
      ? serialized.recruiterId.map(String)
      : (row.recruiterIds || []).map(String);

    recruiterIds.forEach((recruiterId) => {
      if (!recruiterId) return;
      if (!recruiterIdToCandidates[recruiterId]) {
        recruiterIdToCandidates[recruiterId] = [];
      }
      recruiterIdToCandidates[recruiterId].push({
        ...serialized,
        client: resolveClientNameForCandidateRow(row, reqMap),
      });
    });
  });

  const userMap = buildUserMap(users);
  const recruiters = Object.keys(recruiterIdToCandidates)
    .map((recruiterId) => {
      const recruiter = userMap.get(recruiterId);
      if (!recruiter) return null;
      return {
        recruiter: {
          _id: recruiter._id,
          EmployeeName: recruiter.EmployeeName || '—',
          UserType: recruiter.UserType,
        },
        candidateCount: recruiterIdToCandidates[recruiterId].length,
        candidates: recruiterIdToCandidates[recruiterId],
      };
    })
    .filter(Boolean)
    .sort((a, b) => (
      (a.recruiter.EmployeeName || '').localeCompare(b.recruiter.EmployeeName || '')
    ));

  const uniqueCandidateIds = new Set();
  scopedRows.forEach((row) => {
    const id = row.candidate._id?.toString();
    if (id) uniqueCandidateIds.add(id);
  });

  return {
    recruiters,
    total: uniqueCandidateIds.size,
  };
}

async function loadActiveTeamIds(user) {
  const teamIds = (user?.Team || []).filter((id) => id != null && String(id).trim());
  if (!teamIds.length) return [];
  const teamUsers = await NewUser.find({
    _id: { $in: teamIds },
    ...activeUserFilter,
  }).select('_id').lean();
  return teamUsers.map((member) => String(member._id));
}

function emptySearchResult(query) {
  return {
    status: 'Success',
    recruiters: [],
    total: 0,
    query,
  };
}

async function searchDashboardSourceProfiles({
  actorId,
  actorRole,
  name = '',
} = {}) {
  const query = normalizeSourceProfileNameQuery(name);
  if (!query) {
    return emptySearchResult('');
  }

  const user = await NewUser.findById(actorId)
    .select('_id EmployeeName UserType Team Requirements excludedRequirements')
    .lean();

  if (!user) {
    return { status: 'Error', msg: 'User not found.', statusCode: 404 };
  }

  const role = actorRole || user.UserType;
  if (role !== 'Admin' && role !== 'TeamLead') {
    return { status: 'Error', msg: 'You do not have permission to search source profiles.', statusCode: 403 };
  }

  if (role === 'Admin' || user.UserType === 'Admin') {
    const result = await getAdminSourceProfiles({ name: query });
    return { ...result, query };
  }

  const [rawRequirements, users, activeTeamIds] = await Promise.all([
    NewRequirment.find().lean(),
    NewUser.find({ UserType: { $in: ['User', 'TeamLead'] } })
      .select('_id EmployeeName UserType')
      .lean(),
    loadActiveTeamIds(user),
  ]);

  const visibleRequirements = rawRequirements.filter((req) => (
    isRequirementVisibleToTeamLead(user, req, 'all')
  ));
  if (!visibleRequirements.length) {
    return emptySearchResult(query);
  }

  const visibleReqIds = buildVisibleRequirementIdSet(visibleRequirements);
  const allowedRecruiterIds = new Set([String(user._id), ...activeTeamIds]);
  const reqIdValues = [...visibleReqIds];

  const candidateDocs = await CandidateModel.find({
    reqId: { $in: reqIdValues },
  }).lean();

  const requirements = await enrichRequirementsWithClientNames(visibleRequirements);
  const reqMap = buildRequirementMap(requirements);
  const rows = flattenUploadedCandidates(candidateDocs);

  const scopedRows = rows.filter((row) => {
    if (!candidateMatchesSourceProfileName(row.candidate, query)) return false;
    if (!rowMatchesVisibleRequirement(row, visibleReqIds)) return false;
    if (!rowOwnedByAllowedRecruiters(row, allowedRecruiterIds)) return false;
    return true;
  });

  const grouped = groupRowsByRecruiter(scopedRows, users, reqMap);
  return {
    status: 'Success',
    ...grouped,
    query,
  };
}

async function canAuthenticatedUserViewSourceProfile(actorId, actorRole, candidateId) {
  if (!candidateId) {
    return { ok: false, statusCode: 400, message: 'Candidate id is required.' };
  }

  const context = await loadCandidateDocumentContext(candidateId);
  if (context.error) {
    return { ok: false, statusCode: context.error.statusCode || 404, message: context.error.message };
  }

  if (actorRole === 'Admin') {
    return { ok: true };
  }

  const user = await NewUser.findById(actorId)
    .select('_id UserType Team Requirements excludedRequirements')
    .lean();
  if (!user) {
    return { ok: false, statusCode: 401, message: 'Authentication required.' };
  }

  if (user.UserType === 'User' || actorRole === 'User') {
    const allowed = candidateOwnedByUser(context.candidate, context.docRecruiterIds, actorId);
    return allowed
      ? { ok: true }
      : { ok: false, statusCode: 403, message: 'You do not have permission to view this source profile.' };
  }

  if (user.UserType !== 'TeamLead') {
    return { ok: false, statusCode: 403, message: 'You do not have permission to view this source profile.' };
  }

  const rawReqId = String(context.reqId || '').trim();
  const orConditions = [];
  if (rawReqId) orConditions.push({ regId: rawReqId });
  if (rawReqId && isValidObjectId(rawReqId)) orConditions.push({ _id: rawReqId });
  const requirement = orConditions.length
    ? await NewRequirment.findOne({ $or: orConditions }).lean()
    : null;

  if (!isRequirementVisibleToTeamLead(user, requirement, 'all')) {
    return { ok: false, statusCode: 403, message: 'You do not have permission to view this source profile.' };
  }

  const activeTeamIds = await loadActiveTeamIds(user);
  const allowedRecruiterIds = new Set([String(user._id), ...activeTeamIds]);
  const owned = candidateOwnedByUser(context.candidate, context.docRecruiterIds, actorId)
    || (Array.isArray(context.docRecruiterIds)
      ? context.docRecruiterIds.some((id) => allowedRecruiterIds.has(String(id)))
      : allowedRecruiterIds.has(String(context.docRecruiterIds || '')))
    || (Array.isArray(context.candidate?.recruiterId)
      ? context.candidate.recruiterId.some((id) => allowedRecruiterIds.has(String(id)))
      : allowedRecruiterIds.has(String(context.candidate?.recruiterId || '')));

  return owned
    ? { ok: true }
    : { ok: false, statusCode: 403, message: 'You do not have permission to view this source profile.' };
}

module.exports = {
  normalizeSourceProfileNameQuery,
  candidateMatchesSourceProfileName,
  buildVisibleRequirementIdSet,
  rowMatchesVisibleRequirement,
  rowOwnedByAllowedRecruiters,
  searchDashboardSourceProfiles,
  canAuthenticatedUserViewSourceProfile,
};
