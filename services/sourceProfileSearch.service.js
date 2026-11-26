const CandidateModel = require('../models/Candidate');
const NewRequirment = require('../models/Requirement');
const NewUser = require('../models/User');
const { isValidObjectId } = require('../middleware/validateObjectId');
const { enrichRequirementsWithClientNames } = require('../utils/requirementClient');
const { candidateOwnedByUser } = require('../utils/candidateOwnership.util');
const { getTeamLeadClientContext, isRequirementVisibleToTeamLead } = require('../utils/teamLeadRequirements');
const {
  buildTeamLeadProfileAccess,
  classifyTeamLeadRequirement,
  candidateRowVisibleToTeamLead,
} = require('../utils/teamLeadProfileAccess');
const { loadCandidateDocumentContext } = require('./candidateDocumentUpdate.service');
const { getLatestStatusEntry, serializeCandidateStatusHistory } = require('../utils/statusRemarks');
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
  isUploadedOnInRange,
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

function groupRowsByRecruiter(scopedRows, users, reqMap, { includeRequirement = false } = {}) {
  const recruiterIdToCandidates = {};

  scopedRows.forEach((row) => {
    const serialized = serializeCandidateStatusHistory(row.candidate);
    const recruiterIds = Array.isArray(serialized.recruiterId) && serialized.recruiterId.length
      ? serialized.recruiterId.map(String)
      : (row.recruiterIds || []).map(String);
    const requirement = reqMap.get(row.reqId) || reqMap.get(String(row.reqId || '').trim());
    const requirementFields = includeRequirement ? {
      regId: requirement?.regId != null ? String(requirement.regId) : '',
      requirementRole: requirement?.role || '',
      requirementId: requirement?._id ? String(requirement._id) : String(row.reqId || ''),
    } : {};

    recruiterIds.forEach((recruiterId) => {
      if (!recruiterId) return;
      if (!recruiterIdToCandidates[recruiterId]) {
        recruiterIdToCandidates[recruiterId] = [];
      }
      recruiterIdToCandidates[recruiterId].push({
        ...serialized,
        client: resolveClientNameForCandidateRow(row, reqMap),
        ...requirementFields,
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

function emptySearchResult(query) {
  return {
    status: 'Success',
    recruiters: [],
    total: 0,
    query,
  };
}

function displayedCandidateStatus(candidate) {
  const history = Array.isArray(candidate?.Status) ? candidate.Status : [];
  const status = String(getLatestStatusEntry(history)?.Status || '').trim();
  return status || 'No Action Taken';
}

function candidateMatchesHrRequirementSearch(candidate, rawQuery) {
  const query = normalizeSourceProfileNameQuery(rawQuery);
  if (!query) return false;
  if (candidateMatchesSourceProfileName(candidate, query)) return true;
  return displayedCandidateStatus(candidate).toLowerCase().includes(query);
}

async function searchHrRequirementCandidates({ name }) {
  const query = normalizeSourceProfileNameQuery(name);
  if (!query) return emptySearchResult('');

  const [users, candidateDocs, rawRequirements] = await Promise.all([
    NewUser.find({ UserType: { $in: ['User', 'TeamLead', 'Admin', 'HR'] } }).lean(),
    CandidateModel.find().lean(),
    NewRequirment.find().lean(),
  ]);

  const requirements = await enrichRequirementsWithClientNames(rawRequirements);
  const reqMap = buildRequirementMap(requirements);
  const rows = flattenUploadedCandidates(candidateDocs).filter((row) => {
    const requirement = reqMap.get(row.reqId) || reqMap.get(String(row.reqId || '').trim());
    if (!requirement) return false;
    return candidateMatchesHrRequirementSearch(row.candidate, query);
  });
  const grouped = groupRowsByRecruiter(rows, users, reqMap, { includeRequirement: true });

  return {
    status: 'Success',
    query,
    total: grouped.total,
    recruiters: grouped.recruiters,
  };
}

function selectVisibleRequirementsForTeamLead(requirements, user, clientNames = []) {
  return (requirements || []).filter((req) => isRequirementVisibleToTeamLead(user, req, 'all', clientNames));
}

function filterRecruiterProfileRows(rows, {
  visibleReqIds,
  recruiterId,
  name = '',
} = {}) {
  return (rows || []).filter((row) => {
    if (!rowMatchesVisibleRequirement(row, visibleReqIds)) return false;
    if (!candidateOwnedByUser(row.candidate, row.recruiterIds, recruiterId)) return false;
    if (name && !candidateMatchesSourceProfileName(row.candidate, name)) return false;
    return true;
  });
}

function filterTeamLeadProfileRows(rows, {
  visibleReqIds,
  allowedRecruiterIds,
  profileAccess = null,
  fromDate = '',
  toDate = '',
  name = '',
} = {}) {
  return (rows || []).filter((row) => {
    if (profileAccess) {
      if (!candidateRowVisibleToTeamLead(row, profileAccess)) return false;
    } else {
      if (!rowMatchesVisibleRequirement(row, visibleReqIds)) return false;
      if (!rowOwnedByAllowedRecruiters(row, allowedRecruiterIds)) return false;
    }
    if ((fromDate || toDate) && !isUploadedOnInRange(row.candidate?.uploadedOn, fromDate, toDate)) {
      return false;
    }
    if (name && !candidateMatchesSourceProfileName(row.candidate, name)) return false;
    return true;
  });
}

function dedupeSourceProfileRows(rows = []) {
  const seen = new Set();
  const unique = [];
  rows.forEach((row) => {
    const id = row?.candidate?._id?.toString();
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    unique.push(row);
  });
  return unique;
}

function emptyTeamLeadSourceProfiles({ fromDate = '', toDate = '' } = {}) {
  return {
    status: 'Success',
    recruiters: [],
    total: 0,
    period: {
      fromDate: fromDate || null,
      toDate: toDate || null,
    },
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
  if (role === 'HR' || user.UserType === 'HR') {
    return searchHrRequirementCandidates({ name: query });
  }

  if (role !== 'Admin' && role !== 'TeamLead' && role !== 'User') {
    return { status: 'Error', msg: 'You do not have permission to search source profiles.', statusCode: 403 };
  }

  if (role === 'Admin' || user.UserType === 'Admin') {
    const result = await getAdminSourceProfiles({ name: query });
    return { ...result, query };
  }

  if (role === 'User') {
    const listed = await listRecruiterSourceProfiles({
      actorId,
      name: query,
    });
    if (listed.status === 'Error') {
      return listed;
    }
    return { ...listed, query };
  }

  const listed = await listTeamLeadSourceProfiles({
    actorId,
    name: query,
  });
  if (listed.status === 'Error') {
    return listed;
  }
  return { ...listed, query };
}

async function listTeamLeadSourceProfiles({
  actorId,
  fromDate = '',
  toDate = '',
  name = '',
} = {}) {
  const user = await NewUser.findById(actorId)
    .select('_id EmployeeName UserType Team Requirements excludedRequirements Clients')
    .lean();

  if (!user) {
    return { status: 'Error', msg: 'User not found.', statusCode: 404 };
  }
  if (user.UserType !== 'TeamLead') {
    return { status: 'Error', msg: 'You do not have permission to view source profiles.', statusCode: 403 };
  }

  const [rawRequirements, users, clientContext] = await Promise.all([
    NewRequirment.find().lean(),
    NewUser.find({ UserType: { $in: ['User', 'TeamLead', 'Admin', 'HR'] } })
      .select('_id EmployeeName UserType')
      .lean(),
    getTeamLeadClientContext(user),
  ]);

  const visibleRequirements = selectVisibleRequirementsForTeamLead(
    rawRequirements,
    user,
    clientContext.clientNames,
  );
  if (!visibleRequirements.length) {
    return emptyTeamLeadSourceProfiles({ fromDate, toDate });
  }

  const profileAccess = buildTeamLeadProfileAccess(user, visibleRequirements, clientContext.clientNames);
  const visibleReqIds = buildVisibleRequirementIdSet(visibleRequirements);
  const reqIdValues = [...visibleReqIds];

  const candidateDocs = await CandidateModel.find({
    reqId: { $in: reqIdValues },
  }).lean();

  const requirements = await enrichRequirementsWithClientNames(visibleRequirements);
  const reqMap = buildRequirementMap(requirements);
  const rows = flattenUploadedCandidates(candidateDocs);
  const scopedRows = dedupeSourceProfileRows(filterTeamLeadProfileRows(rows, {
    profileAccess,
    fromDate,
    toDate,
    name,
  }));

  const grouped = groupRowsByRecruiter(scopedRows, users, reqMap);
  return {
    status: 'Success',
    ...grouped,
    period: {
      fromDate: fromDate || null,
      toDate: toDate || null,
    },
  };
}

async function listRecruiterSourceProfiles({
  actorId,
  name = '',
} = {}) {
  const user = await NewUser.findById(actorId)
    .select('_id EmployeeName UserType Requirements')
    .lean();

  if (!user) {
    return { status: 'Error', msg: 'User not found.', statusCode: 404 };
  }
  if (user.UserType !== 'User') {
    return { status: 'Error', msg: 'You do not have permission to view source profiles.', statusCode: 403 };
  }

  const assignedIds = (user.Requirements || []).map((id) => String(id)).filter(Boolean);
  const claimQuery = { 'claimedBy.userId': String(user._id) };
  const requirementQuery = assignedIds.length
    ? { $or: [{ _id: { $in: assignedIds } }, claimQuery] }
    : claimQuery;
  const visibleRequirements = await NewRequirment.find(requirementQuery).lean();
  if (!visibleRequirements.length) {
    return emptySearchResult(normalizeSourceProfileNameQuery(name));
  }

  const visibleReqIds = buildVisibleRequirementIdSet(visibleRequirements);
  const reqIdValues = [...visibleReqIds];
  const candidateDocs = await CandidateModel.find({
    reqId: { $in: reqIdValues },
  }).lean();

  const requirements = await enrichRequirementsWithClientNames(visibleRequirements);
  const reqMap = buildRequirementMap(requirements);
  const scopedRows = dedupeSourceProfileRows(filterRecruiterProfileRows(
    flattenUploadedCandidates(candidateDocs),
    {
      visibleReqIds,
      recruiterId: String(user._id),
      name,
    },
  ));

  const grouped = groupRowsByRecruiter(scopedRows, [user], reqMap);
  return {
    status: 'Success',
    ...grouped,
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

  if (actorRole === 'Admin' || actorRole === 'HR') {
    return { ok: true };
  }

  const user = await NewUser.findById(actorId)
    .select('_id UserType Team Requirements excludedRequirements Clients')
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

  const { clientNames } = await getTeamLeadClientContext(user);
  const accessLevel = classifyTeamLeadRequirement(user, requirement, clientNames);
  if (accessLevel === 'none') {
    return { ok: false, statusCode: 403, message: 'You do not have permission to view this source profile.' };
  }

  const canView = accessLevel === 'full'
    || candidateOwnedByUser(context.candidate, context.docRecruiterIds, actorId);
  if (!canView) {
    return { ok: false, statusCode: 403, message: 'You do not have permission to view this source profile.' };
  }

  return { ok: true, canUpdateProfileStatus: accessLevel === 'full' };
}

module.exports = {
  normalizeSourceProfileNameQuery,
  candidateMatchesSourceProfileName,
  candidateMatchesHrRequirementSearch,
  displayedCandidateStatus,
  buildVisibleRequirementIdSet,
  rowMatchesVisibleRequirement,
  rowOwnedByAllowedRecruiters,
  selectVisibleRequirementsForTeamLead,
  filterRecruiterProfileRows,
  filterTeamLeadProfileRows,
  dedupeSourceProfileRows,
  searchDashboardSourceProfiles,
  listTeamLeadSourceProfiles,
  listRecruiterSourceProfiles,
  canAuthenticatedUserViewSourceProfile,
};
