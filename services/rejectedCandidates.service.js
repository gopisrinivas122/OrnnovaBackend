const NewUser = require('../models/User');
const {
  isUploadedCandidate,
  getLatestStatus,
  isRejectedStatus,
  getCandidateRejectionDetails,
} = require('../utils/candidateStatusMap');

function normalizeRecruiterIds(candidate) {
  const ids = new Set();
  (candidate?.recruiterId || []).forEach((id) => {
    if (id != null && String(id).trim()) ids.add(String(id).trim());
  });
  return [...ids];
}

function resolveRecruiterName(candidate, recruiterMap) {
  if (candidate?.recruiterName) return candidate.recruiterName;
  const recruiterId = normalizeRecruiterIds(candidate)[0];
  if (recruiterId && recruiterMap.has(recruiterId)) {
    return recruiterMap.get(recruiterId).EmployeeName || '—';
  }
  return '—';
}

function resolveTeamLeadNames(recruiterIds, users = []) {
  const names = new Set();
  recruiterIds.forEach((recruiterId) => {
    users.forEach((user) => {
      if (user.UserType !== 'TeamLead') return;
      const teamIds = (user.Team || []).map(String);
      if (teamIds.includes(String(recruiterId))) {
        names.add(user.EmployeeName || '—');
      }
    });
  });
  return [...names].join(', ') || '—';
}

function candidateMatchesScope(candidate, docRecruiterId, scope) {
  const candidateRecruiterIds = normalizeRecruiterIds(candidate);
  const docRecruiterIds = normalizeRecruiterIds({ recruiterId: docRecruiterId });

  if (scope.userType === 'Admin') {
    return true;
  }

  if (scope.userType === 'TeamLead') {
    const allowedIds = new Set([
      String(scope.userId),
      ...(scope.teamIds || []).map(String),
    ]);
    return [...candidateRecruiterIds, ...docRecruiterIds].some((id) => allowedIds.has(String(id)));
  }

  const allowedIds = new Set([String(scope.userId)]);
  return [...candidateRecruiterIds, ...docRecruiterIds].some((id) => allowedIds.has(String(id)));
}

function collectRejectedCandidates(candidateDocs = [], scope = {}) {
  const rejected = [];

  candidateDocs.forEach((doc) => {
    (doc.candidates || []).forEach((candidate) => {
      if (!isUploadedCandidate(candidate)) return;
      if (!isRejectedStatus(getLatestStatus(candidate))) return;
      if (!candidateMatchesScope(candidate, doc.recruiterId, scope)) return;

      rejected.push({
        candidate,
        docRecruiterId: doc.recruiterId,
      });
    });
  });

  return rejected;
}

function resolveUploaderInfo(entry, recruiterMap) {
  const docRecruiterIds = normalizeRecruiterIds({ recruiterId: entry.docRecruiterId });
  const candidateRecruiterIds = normalizeRecruiterIds(entry.candidate);
  const uploaderId = candidateRecruiterIds[0] || docRecruiterIds[0];
  const user = uploaderId ? recruiterMap.get(String(uploaderId)) : null;

  let uploadedByRole = '—';
  if (user?.UserType === 'TeamLead') uploadedByRole = 'Team Lead';
  else if (user?.UserType === 'User') uploadedByRole = 'Recruiter';

  return {
    uploadedByName: user?.EmployeeName || entry.candidate?.recruiterName || '—',
    uploadedByRole,
  };
}

function buildRejectedCandidateRow(entry, recruiterMap, users) {
  const { candidate } = entry;
  const recruiterIds = normalizeRecruiterIds(candidate);
  const rejection = getCandidateRejectionDetails(candidate) || {};
  const candidateName = `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || '—';
  const uploader = resolveUploaderInfo(entry, recruiterMap);

  return {
    candidateId: candidate._id?.toString?.() || String(candidate._id || ''),
    candidateName,
    uploadedByName: uploader.uploadedByName,
    uploadedByRole: uploader.uploadedByRole,
    recruiterName: resolveRecruiterName(candidate, recruiterMap),
    teamLeadName: resolveTeamLeadNames(recruiterIds, users),
    rejectionStage: rejection.rejectionStage || '—',
    rejectedDate: rejection.rejectedDate || null,
    rejectedBy: rejection.rejectedByName || rejection.rejectedBy || '—',
    rejectionReason: rejection.rejectionReason || '—',
    currentStatus: rejection.currentStatus || getLatestStatus(candidate),
  };
}

async function buildRejectedCandidatesScope(userId) {
  if (!userId) {
    return { userType: 'Admin', userId: '', teamIds: [] };
  }

  const user = await NewUser.findById(userId).lean();
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  if (user.UserType === 'Admin') {
    return { userType: 'Admin', userId: user._id.toString(), teamIds: [] };
  }

  if (user.UserType === 'TeamLead') {
    return {
      userType: 'TeamLead',
      userId: user._id.toString(),
      teamIds: (user.Team || []).map(String),
    };
  }

  return {
    userType: 'User',
    userId: user._id.toString(),
    teamIds: [],
  };
}

async function getRejectedCandidatesReport(candidateDocs = [], userId = null) {
  const scope = await buildRejectedCandidatesScope(userId);
  const rejectedEntries = collectRejectedCandidates(candidateDocs, scope);

  const recruiterIds = new Set();
  rejectedEntries.forEach(({ candidate, docRecruiterId }) => {
    normalizeRecruiterIds(candidate).forEach((id) => recruiterIds.add(id));
    normalizeRecruiterIds({ recruiterId: docRecruiterId }).forEach((id) => recruiterIds.add(id));
  });

  const users = await NewUser.find({
    $or: [
      { _id: { $in: [...recruiterIds] } },
      { UserType: 'TeamLead' },
    ],
  }).lean();

  const recruiterMap = new Map(users.map((user) => [user._id.toString(), user]));

  const rows = rejectedEntries
    .map((entry) => buildRejectedCandidateRow(entry, recruiterMap, users))
    .sort((a, b) => new Date(b.rejectedDate || 0) - new Date(a.rejectedDate || 0));

  return {
    total: rows.length,
    rows,
    scope: {
      userType: scope.userType,
      userId: scope.userId || null,
    },
  };
}

module.exports = {
  buildRejectedCandidatesScope,
  collectRejectedCandidates,
  getRejectedCandidatesReport,
  buildRejectedCandidateRow,
};
