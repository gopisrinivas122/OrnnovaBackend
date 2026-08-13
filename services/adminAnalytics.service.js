const NewRequirment = require('../models/Requirement');
const NewUser = require('../models/User');
const CandidateModel = require('../models/Candidate');
const {
  FUNNEL_STAGES,
  getLatestStatus,
  isUploadedCandidate,
  hasReachedStage,
  isRejectedStatus,
  isJoinedStatus,
  hasOfferStatus,
  parseInterviewDate,
} = require('../utils/candidateStatusMap');
const {
  isRequirementWorkBlocked,
  normalizeRequirementType,
} = require('../utils/requirementType');

function flattenUploadedCandidates(candidateDocs = []) {
  const rows = [];

  candidateDocs.forEach((doc) => {
    const reqId = doc.reqId?.toString();
    (doc.candidates || []).forEach((candidate) => {
      if (!isUploadedCandidate(candidate)) return;
      rows.push({
        candidate,
        reqId,
        recruiterIds: Array.isArray(doc.recruiterId) ? doc.recruiterId.map(String) : [],
      });
    });
  });

  return rows;
}

function buildRequirementMap(requirements = []) {
  const map = new Map();
  requirements.forEach((req) => {
    map.set(req._id.toString(), req);
  });
  return map;
}

function buildUserMap(users = []) {
  const map = new Map();
  users.forEach((user) => {
    map.set(user._id.toString(), user);
  });
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

function isUploadedOnInRange(uploadedOn, fromDate, toDate) {
  if (!fromDate && !toDate) return true;
  if (!uploadedOn) return false;

  const date = new Date(uploadedOn);
  if (Number.isNaN(date.getTime())) return false;

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

function resolveUploaderIds(row) {
  const ids = new Set();

  (row.recruiterIds || []).forEach((id) => {
    if (id != null && String(id).trim()) ids.add(String(id).trim());
  });

  const candidateRecruiterId = row.candidate?.recruiterId;
  if (Array.isArray(candidateRecruiterId)) {
    candidateRecruiterId.forEach((id) => {
      if (id != null && String(id).trim()) ids.add(String(id).trim());
    });
  } else if (candidateRecruiterId != null && String(candidateRecruiterId).trim()) {
    ids.add(String(candidateRecruiterId).trim());
  }

  return [...ids];
}

function resolvePrimaryUploaderId(row) {
  const ids = resolveUploaderIds(row);
  return ids[0] || null;
}

function buildUploaderBreakdown(rows, reqMap, fromDate, toDate) {
  const counts = new Map();

  rows.forEach((row) => {
    if (!isUploadedOnInRange(row.candidate.uploadedOn, fromDate, toDate)) return;
    const uploaderId = resolvePrimaryUploaderId(row);
    if (!uploaderId) return;
    const req = reqMap.get(row.reqId);
    const client = req?.client || '—';
    const requirementRole = req?.role || '—';
    const key = `${uploaderId}\u0001${client}\u0001${requirementRole}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return [...counts.entries()].map(([key, count]) => {
    const [uploaderId, client, requirementRole] = key.split('\u0001');
    return { uploaderId, client, requirementRole, count };
  });
}

function buildProfilesSourcedRow(userMap, entry, roleLabel) {
  const user = userMap.get(entry.uploaderId);
  return {
    userId: entry.uploaderId,
    name: user?.EmployeeName || 'Unknown',
    role: roleLabel,
    client: entry.client,
    requirementRole: entry.requirementRole,
    profilesSourced: entry.count,
    isTotal: false,
  };
}

function computeProfilesSourcedReport(rows, users, reqMap, filters = {}) {
  const fromDate = filters.fromDate || '';
  const toDate = filters.toDate || '';
  const recruiterId = filters.recruiterId || '';
  const teamLeadId = filters.teamLeadId || '';

  const userMap = buildUserMap(users);
  const breakdown = buildUploaderBreakdown(rows, reqMap, fromDate, toDate);

  const filterOptions = {
    teamLeads: users
      .filter((user) => user.UserType === 'TeamLead')
      .map((user) => ({ id: user._id.toString(), name: user.EmployeeName || '—' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    recruiters: users
      .filter((user) => user.UserType === 'User')
      .map((user) => ({ id: user._id.toString(), name: user.EmployeeName || '—' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };

  const resolveRoleLabel = (uploaderId) => {
    const user = userMap.get(uploaderId);
    if (!user) return 'Recruiter';
    if (teamLeadId && uploaderId === teamLeadId) return 'Team Lead';
    return user.UserType === 'TeamLead' ? 'Team Lead' : 'Recruiter';
  };

  let reportRows = [];
  let total = 0;

  if (recruiterId) {
    reportRows = breakdown
      .filter((entry) => entry.uploaderId === recruiterId)
      .map((entry) => buildProfilesSourcedRow(userMap, entry, resolveRoleLabel(recruiterId)))
      .sort((a, b) => a.client.localeCompare(b.client) || a.requirementRole.localeCompare(b.requirementRole));
    total = reportRows.reduce((sum, row) => sum + row.profilesSourced, 0);
  } else if (teamLeadId) {
    const teamLead = userMap.get(teamLeadId);
    if (teamLead) {
      const memberIds = new Set([teamLeadId, ...((teamLead.Team || []).map(String))]);
      reportRows = breakdown
        .filter((entry) => memberIds.has(entry.uploaderId))
        .map((entry) => buildProfilesSourcedRow(userMap, entry, resolveRoleLabel(entry.uploaderId)))
        .sort((a, b) => (
          a.name.localeCompare(b.name)
          || a.client.localeCompare(b.client)
          || a.requirementRole.localeCompare(b.requirementRole)
        ));
      total = reportRows.reduce((sum, row) => sum + row.profilesSourced, 0);
      reportRows.push({
        userId: '',
        name: 'Total',
        role: '',
        client: '',
        requirementRole: '',
        profilesSourced: total,
        isTotal: true,
      });
    }
  } else {
    reportRows = breakdown
      .filter((entry) => {
        const user = userMap.get(entry.uploaderId);
        return user && ['User', 'TeamLead'].includes(user.UserType);
      })
      .map((entry) => buildProfilesSourcedRow(userMap, entry, resolveRoleLabel(entry.uploaderId)))
      .sort((a, b) => (
        a.name.localeCompare(b.name)
        || a.client.localeCompare(b.client)
        || a.requirementRole.localeCompare(b.requirementRole)
      ));
    total = reportRows.reduce((sum, row) => sum + row.profilesSourced, 0);
  }

  return {
    filters: {
      fromDate: fromDate || null,
      toDate: toDate || null,
      recruiterId: recruiterId || null,
      teamLeadId: teamLeadId || null,
    },
    filterOptions,
    rows: reportRows,
    total,
  };
}

function computePipelineFunnel(rows) {
  return FUNNEL_STAGES.map((stage) => {
    const count = rows.filter((row) => {
      const status = getLatestStatus(row.candidate);
      if (isRejectedStatus(status)) return false;
      return hasReachedStage(status, stage.minRank);
    }).length;

    return { key: stage.key, label: stage.label, count };
  });
}

function computeDashboardStats(requirements, rows) {
  const openRequirements = requirements.filter((req) => {
    const normalized = normalizeRequirementType(req.requirementtype);
    return normalized && !isRequirementWorkBlocked(normalized);
  });

  const onHold = requirements.filter(
    (req) => normalizeRequirementType(req.requirementtype) === 'Hold'
  ).length;

  let interviews = 0;
  let offers = 0;
  let offerAccept = 0;
  let joinings = 0;
  let rejections = 0;

  rows.forEach((row) => {
    const status = getLatestStatus(row.candidate);
    if (isRejectedStatus(status)) {
      rejections += 1;
      return;
    }
    if (hasReachedStage(status, 5)) interviews += 1;
    if (hasOfferStatus(status, row.candidate)) offers += 1;
    if (getLatestStatus(row.candidate) === 'Onboard Confirmation' || String(row.candidate.offerInHand || '').toLowerCase() === 'yes') {
      offerAccept += 1;
    }
    if (isJoinedStatus(status)) joinings += 1;
  });

  const positions = openRequirements.reduce((sum, req) => sum + (req.numberOfPositions || 1), 0);
  const closurePercent = positions > 0 ? Math.round((joinings / positions) * 100) : 0;

  return {
    openRequirements: openRequirements.length,
    positions,
    profiles: rows.length,
    interviews,
    joinings,
    offers,
    offerAccept,
    rejections,
    onHold,
    closurePercent,
  };
}

function computeUpcomingInterviews(rows, reqMap, days = 3) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + days);
  end.setHours(23, 59, 59, 999);

  return rows
    .map((row) => {
      const interviewDate = parseInterviewDate(row.candidate.interviewDate);
      if (!interviewDate) return null;
      if (interviewDate < now || interviewDate > end) return null;

      const req = reqMap.get(row.reqId);
      const name = `${row.candidate.firstName || ''} ${row.candidate.lastName || ''}`.trim();
      const status = getLatestStatus(row.candidate) || 'No Action Taken';

      return {
        candidateName: name || '—',
        client: req?.client || '—',
        role: row.candidate.role || req?.role || '—',
        status,
        interviewDate: interviewDate.toISOString(),
        interviewDateLabel: interviewDate.toLocaleString('en-IN', {
          day: '2-digit',
          month: 'short',
          hour: row.candidate.interviewTime ? '2-digit' : undefined,
          minute: row.candidate.interviewTime ? '2-digit' : undefined,
        }) + (row.candidate.interviewTime ? ` (${row.candidate.interviewTime})` : ''),
        requirementId: row.reqId,
        regId: req?.regId || row.reqId,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.interviewDate) - new Date(b.interviewDate));
}

function computeRequirementFunnel(requirementId, requirements, rows, userMap = new Map()) {
  const req = requirements.find((item) => item._id.toString() === requirementId);
  if (!req) return null;

  const reqRows = rows.filter((row) => row.reqId === requirementId);
  const recruiterStats = new Map();

  const activeRows = reqRows.filter((row) => !isRejectedStatus(getLatestStatus(row.candidate)));
  const rejectedRows = reqRows.filter((row) => isRejectedStatus(getLatestStatus(row.candidate)));

  activeRows.forEach((row) => {
    const name = resolveRecruiterName(row, userMap);
    if (!recruiterStats.has(name)) {
      recruiterStats.set(name, { recruiter: name, shared: 0, joined: 0 });
    }
    const status = getLatestStatus(row.candidate);
    if (hasReachedStage(status, 3)) recruiterStats.get(name).shared += 1;
    if (isJoinedStatus(status)) recruiterStats.get(name).joined += 1;
  });

  const statuses = activeRows.map((row) => getLatestStatus(row.candidate));

  return {
    requirementId,
    regId: req.regId,
    client: req.client,
    role: req.role,
    positionsOpen: req.numberOfPositions || 1,
    profilesReceived: reqRows.length,
    profilesShared: statuses.filter((s) => hasReachedStage(s, 3)).length,
    shortlisted: statuses.filter((s) => hasReachedStage(s, 4)).length,
    interviews: statuses.filter((s) => hasReachedStage(s, 5)).length,
    selected: statuses.filter((s) => hasReachedStage(s, 7)).length,
    offersReleased: statuses.filter((s) => hasReachedStage(s, 8)).length,
    offersAccepted: activeRows.filter((row) => hasOfferStatus(getLatestStatus(row.candidate), row.candidate)).length,
    joined: statuses.filter((s) => isJoinedStatus(s)).length,
    rejected: rejectedRows.length,
    recruiters: Array.from(recruiterStats.values()),
  };
}

async function getAdminAnalytics(filters = {}) {
  const [requirements, users, candidateDocs] = await Promise.all([
    NewRequirment.find().lean(),
    NewUser.find({ UserType: { $in: ['User', 'TeamLead'] } }).lean(),
    CandidateModel.find().lean(),
  ]);

  const rows = flattenUploadedCandidates(candidateDocs);
  const reqMap = buildRequirementMap(requirements);
  const userMap = buildUserMap(users);

  return {
    status: 'Success',
    generatedAt: new Date().toISOString(),
    dashboardStats: computeDashboardStats(requirements, rows),
    pipelineFunnel: computePipelineFunnel(rows),
    upcomingInterviews: computeUpcomingInterviews(rows, reqMap, 3),
    profilesSourcedReport: computeProfilesSourcedReport(rows, users, reqMap, filters),
  };
}

module.exports = {
  getAdminAnalytics,
  computeRequirementFunnel,
  flattenUploadedCandidates,
  buildRequirementMap,
  computeProfilesSourcedReport,
};
