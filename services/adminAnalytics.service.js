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

function computePipelineFunnel(rows) {
  return FUNNEL_STAGES.map((stage) => {
    const count = rows.filter((row) => {
      const status = getLatestStatus(row.candidate);
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
    if (hasReachedStage(status, 5)) interviews += 1;
    if (hasOfferStatus(status, row.candidate)) offers += 1;
    if (getLatestStatus(row.candidate) === 'Onboard Confirmation' || String(row.candidate.offerInHand || '').toLowerCase() === 'yes') {
      offerAccept += 1;
    }
    if (isJoinedStatus(status)) joinings += 1;
    if (isRejectedStatus(status)) rejections += 1;
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

function computeOpenRequirements(requirements, rows, reqMap) {
  return requirements
    .filter((req) => {
      const normalized = normalizeRequirementType(req.requirementtype);
      return normalized && normalized !== 'Cancel';
    })
    .map((req) => {
      const reqId = req._id.toString();
      const reqRows = rows.filter((row) => row.reqId === reqId);
      const shared = reqRows.filter((row) => hasReachedStage(getLatestStatus(row.candidate), 3)).length;

      return {
        reqId: req.regId || reqId,
        requirementId: reqId,
        client: req.client || '—',
        role: req.role || '—',
        openings: req.numberOfPositions || 1,
        shared,
        status: normalizeRequirementType(req.requirementtype) || 'High',
      };
    })
    .sort((a, b) => b.shared - a.shared);
}

function computeRecruiterPerformance(rows, userMap) {
  const stats = new Map();

  const ensure = (name) => {
    if (!stats.has(name)) {
      stats.set(name, {
        recruiter: name,
        shared: 0,
        shortlisted: 0,
        interview: 0,
        offers: 0,
        joined: 0,
      });
    }
    return stats.get(name);
  };

  rows.forEach((row) => {
    const name = resolveRecruiterName(row, userMap);
    const entry = ensure(name);
    const status = getLatestStatus(row.candidate);

    if (hasReachedStage(status, 3)) entry.shared += 1;
    if (hasReachedStage(status, 4)) entry.shortlisted += 1;
    if (hasReachedStage(status, 5)) entry.interview += 1;
    if (hasOfferStatus(status, row.candidate)) entry.offers += 1;
    if (isJoinedStatus(status)) entry.joined += 1;
  });

  return Array.from(stats.values()).sort((a, b) => b.shared - a.shared);
}

function computeClientStats(requirements, rows, reqMap) {
  const stats = new Map();

  requirements.forEach((req) => {
    const client = req.client || 'Unknown';
    if (!stats.has(client)) {
      stats.set(client, {
        client,
        requirements: 0,
        shared: 0,
        offers: 0,
        joined: 0,
      });
    }
    stats.get(client).requirements += 1;
  });

  rows.forEach((row) => {
    const req = reqMap.get(row.reqId);
    const client = req?.client || 'Unknown';
    const entry = stats.get(client) || {
      client,
      requirements: 0,
      shared: 0,
      offers: 0,
      joined: 0,
    };
    if (!stats.has(client)) stats.set(client, entry);

    const status = getLatestStatus(row.candidate);
    if (hasReachedStage(status, 3)) entry.shared += 1;
    if (hasOfferStatus(status, row.candidate)) entry.offers += 1;
    if (isJoinedStatus(status)) entry.joined += 1;
  });

  return Array.from(stats.values()).sort((a, b) => b.shared - a.shared);
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

  reqRows.forEach((row) => {
    const name = resolveRecruiterName(row, userMap);
    if (!recruiterStats.has(name)) {
      recruiterStats.set(name, { recruiter: name, shared: 0, joined: 0 });
    }
    const status = getLatestStatus(row.candidate);
    if (hasReachedStage(status, 3)) recruiterStats.get(name).shared += 1;
    if (isJoinedStatus(status)) recruiterStats.get(name).joined += 1;
  });

  const statuses = reqRows.map((row) => getLatestStatus(row.candidate));

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
    offersAccepted: reqRows.filter((row) => hasOfferStatus(getLatestStatus(row.candidate), row.candidate)).length,
    joined: statuses.filter((s) => isJoinedStatus(s)).length,
    recruiters: Array.from(recruiterStats.values()),
  };
}

async function getAdminAnalytics() {
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
    openRequirements: computeOpenRequirements(requirements, rows, reqMap),
    recruiterPerformance: computeRecruiterPerformance(rows, userMap),
    clientStats: computeClientStats(requirements, rows, reqMap),
    upcomingInterviews: computeUpcomingInterviews(rows, reqMap, 3),
  };
}

module.exports = {
  getAdminAnalytics,
  computeRequirementFunnel,
  flattenUploadedCandidates,
  buildRequirementMap,
};
