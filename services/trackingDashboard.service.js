const NewRequirment = require('../models/Requirement');
const NewUser = require('../models/User');
const CandidateModel = require('../models/Candidate');
const {
  flattenUploadedCandidates,
  buildRequirementMap,
} = require('./adminAnalytics.service');
const { getLatestStatus } = require('../utils/candidateStatusMap');
const {
  matchesStage,
  getStageByKey,
  getKpiStages,
  getFlowStages,
  getLastStatusDate,
  resolvePrimaryStage,
} = require('../utils/trackingStageMap');

function buildUserMap(users = []) {
  const map = new Map();
  users.forEach((user) => map.set(user._id.toString(), user));
  return map;
}

function resolveRecruiterName(row, userMap) {
  if (row.candidate.recruiterName) return row.candidate.recruiterName;
  const recruiterId = row.recruiterIds[0];
  if (recruiterId && userMap.has(recruiterId)) {
    return userMap.get(recruiterId).EmployeeName || 'Unknown';
  }
  return 'Unknown';
}

function buildViewerScope(viewer, requirements = [], filters = {}) {
  if (!viewer) {
    return { requirementIds: new Set(), recruiterIds: new Set() };
  }

  let recruiterIds = null;
  let requirementIds = new Set();

  if (viewer.UserType === 'Admin') {
    requirementIds = new Set(requirements.map((req) => req._id.toString()));
    recruiterIds = null;

    if (filters.teamLeadId) {
      const tl = filters.teamLeadUser;
      if (tl) {
        recruiterIds = new Set([tl._id.toString(), ...(tl.Team || []).map(String)]);
        const clientIds = new Set((tl.Clients || []).map(String));
        const assignedReqIds = new Set((tl.Requirements || []).map(String));
        requirementIds = new Set();
        requirements.forEach((req) => {
          const reqId = req._id.toString();
          if (clientIds.has(String(req.clientId)) || assignedReqIds.has(reqId)) {
            requirementIds.add(reqId);
          }
        });
      }
    }

    if (filters.recruiterId) {
      recruiterIds = new Set([filters.recruiterId]);
    }
  } else if (viewer.UserType === 'TeamLead') {
    const clientIds = new Set((viewer.Clients || []).map(String));
    const assignedReqIds = new Set((viewer.Requirements || []).map(String));
    recruiterIds = new Set([viewer._id.toString(), ...(viewer.Team || []).map(String)]);
    requirements.forEach((req) => {
      const reqId = req._id.toString();
      if (clientIds.has(String(req.clientId)) || assignedReqIds.has(reqId)) {
        requirementIds.add(reqId);
      }
    });
    if (filters.recruiterId && recruiterIds.has(filters.recruiterId)) {
      recruiterIds = new Set([filters.recruiterId]);
    }
  } else {
    requirementIds = new Set((viewer.Requirements || []).map(String));
    recruiterIds = new Set([viewer._id.toString()]);
  }

  return { requirementIds, recruiterIds };
}

function rowInScope(row, scope) {
  if (!scope.requirementIds.has(row.reqId)) return false;
  if (!scope.recruiterIds) return true;
  return row.recruiterIds.some((id) => scope.recruiterIds.has(id));
}

function passesDateFilter(candidate, fromDate, toDate) {
  if (!fromDate && !toDate) return true;
  const reference = getLastStatusDate(candidate) || candidate.uploadedOn;
  if (!reference) return true;
  const date = new Date(reference);
  if (Number.isNaN(date.getTime())) return true;
  if (fromDate) {
    const from = new Date(fromDate);
    from.setHours(0, 0, 0, 0);
    if (date < from) return false;
  }
  if (toDate) {
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);
    if (date > to) return false;
  }
  return true;
}

function formatCandidateRow(row, reqMap, userMap) {
  const req = reqMap.get(row.reqId);
  const status = getLatestStatus(row.candidate);
  const name = `${row.candidate.firstName || ''} ${row.candidate.lastName || ''}`.trim();
  const lastUpdated = getLastStatusDate(row.candidate) || row.candidate.uploadedOn;
  const primaryStage = resolvePrimaryStage(status, row.candidate);

  return {
    candidateId: row.candidate._id?.toString(),
    candidateName: name || '—',
    client: req?.client || '—',
    regId: req?.regId || row.reqId,
    requirementId: row.reqId,
    role: row.candidate.role || req?.role || '—',
    recruiter: resolveRecruiterName(row, userMap),
    currentStatus: status,
    pipelineStageKey: primaryStage.key,
    pipelineStageLabel: primaryStage.label,
    interviewDate: row.candidate.interviewDate || '',
    interviewTime: row.candidate.interviewTime || '',
    interviewDateLabel: (() => {
      const parsed = row.candidate.interviewDate;
      if (!parsed) return '—';
      const date = new Date(parsed);
      if (Number.isNaN(date.getTime()) || date.getFullYear() < 1971) return '—';
      return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    })(),
    lastUpdated: lastUpdated ? new Date(lastUpdated).toISOString() : '',
    lastUpdatedLabel: lastUpdated
      ? new Date(lastUpdated).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : '—',
  };
}

async function loadTrackingContext(viewerUserId, filters = {}) {
  const [requirements, users, candidateDocs, viewer] = await Promise.all([
    NewRequirment.find().lean(),
    NewUser.find().lean(),
    CandidateModel.find().lean(),
    NewUser.findById(viewerUserId).lean(),
  ]);

  if (!viewer) {
    return { error: 'User not found' };
  }

  let teamLeadUser = null;
  if (filters.teamLeadId) {
    teamLeadUser = users.find((user) => user._id.toString() === filters.teamLeadId) || null;
  }

  const rows = flattenUploadedCandidates(candidateDocs);
  const reqMap = buildRequirementMap(requirements);
  const userMap = buildUserMap(users);
  const scope = buildViewerScope(viewer, requirements, {
    ...filters,
    teamLeadUser,
  });

  const scopedRows = rows.filter((row) => {
    if (!rowInScope(row, scope)) return false;
    return passesDateFilter(row.candidate, filters.fromDate, filters.toDate);
  });

  const teamLeads = users
    .filter((user) => user.UserType === 'TeamLead')
    .map((user) => ({ id: user._id.toString(), name: user.EmployeeName }));

  const recruiters = users
    .filter((user) => ['User', 'TeamLead'].includes(user.UserType))
    .map((user) => ({ id: user._id.toString(), name: user.EmployeeName, type: user.UserType }));

  return {
    viewer,
    scopedRows,
    reqMap,
    userMap,
    teamLeads,
    recruiters,
  };
}

function countByStage(scopedRows) {
  const counts = {};
  getFlowStages().forEach((stage) => {
    counts[stage.key] = 0;
  });

  scopedRows.forEach((row) => {
    const status = getLatestStatus(row.candidate);
    getFlowStages().forEach((stage) => {
      if (matchesStage(stage.key, status, row.candidate)) {
        counts[stage.key] += 1;
      }
    });
  });

  return counts;
}

async function getTrackingSummary(viewerUserId, filters = {}) {
  const context = await loadTrackingContext(viewerUserId, filters);
  if (context.error) {
    return { status: 'Error', msg: context.error };
  }

  const counts = countByStage(context.scopedRows);
  const kpiStages = getKpiStages().map((stage) => ({
    ...stage,
    count: counts[stage.key] || 0,
  }));
  const flowStages = getFlowStages().map((stage) => ({
    ...stage,
    count: counts[stage.key] || 0,
  }));

  const candidates = context.scopedRows.map((row) =>
    formatCandidateRow(row, context.reqMap, context.userMap)
  );

  return {
    status: 'Success',
    generatedAt: new Date().toISOString(),
    role: context.viewer.UserType,
    filters,
    totalProfiles: context.scopedRows.length,
    kpiStages,
    flowStages,
    candidates,
    filterOptions: {
      teamLeads: context.teamLeads,
      recruiters: context.recruiters,
    },
  };
}

async function getStageCandidates(viewerUserId, stageKey, filters = {}) {
  const stage = getStageByKey(stageKey);
  if (!stage) {
    return { status: 'Error', msg: 'Invalid stage key.' };
  }

  const context = await loadTrackingContext(viewerUserId, filters);
  if (context.error) {
    return { status: 'Error', msg: context.error };
  }

  const candidates = context.scopedRows
    .filter((row) => {
      const status = getLatestStatus(row.candidate);
      return matchesStage(stageKey, status, row.candidate);
    })
    .map((row) => formatCandidateRow(row, context.reqMap, context.userMap));

  return {
    status: 'Success',
    stage: stage.key,
    label: stage.label,
    count: candidates.length,
    candidates,
  };
}

module.exports = {
  getTrackingSummary,
  getStageCandidates,
};
