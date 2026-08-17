const REJECTED_STATUSES = new Set([
  'Rejected',
  'Declined',
  'Candidate Declined',
  'Client Rejected',
  'L1 Rejected',
  'L2 Rejected',
  'L3 Rejected',
  'ORNNOVA Screening Reject',
  'Internal Reject',
]);

const REJECTION_STAGE_LABELS = {
  'ORNNOVA Screening Reject': 'ORNNOVA Screening Reject',
  Rejected: 'Screening Rejected',
  'Client Rejected': 'Client Rejected',
  'Internal Reject': 'Internal Rejected',
  'L1 Rejected': 'Interview Scheduled',
  'L2 Rejected': 'Interview Completed',
  'L3 Rejected': 'HR Round',
  Declined: 'Offer Declined',
  'Candidate Declined': 'Offer Declined',
};

const JOINED_STATUSES = new Set(['Onboarded', 'On Boarded']);

const OFFER_STATUSES = new Set(['Onboard Confirmation', 'Offer Released', 'Offer Accepted', 'L2 Selected']);

const STATUS_RANK = {
  'No Action Taken': 1,
  'Ornnova Screen Selected': 2,
  'Shared with Client': 3,
  'Client Rejected': 3,
  'L1 Schedule': 4,
  'L1 Pending': 4,
  'L1 Selected': 5,
  'L1 Rejected': 4,
  'L2 Schedule': 6,
  'L2 Pending': 6,
  'L2 Selected': 7,
  'L2 Rejected': 6,
  'Selected': 7,
  'Offer Released': 8,
  'Offer Accepted': 8,
  'Onboard Confirmation': 8,
  'Onboarded': 9,
  'On Boarded': 9,
  Rejected: 2,
  Declined: 8,
};

const FUNNEL_STAGES = [
  { key: 'sourced', label: 'Profiles Sourced', minRank: 1 },
  { key: 'shared', label: 'Profiles Shared', minRank: 3 },
  { key: 'shortlisted', label: 'Client Shortlisted', minRank: 4 },
  { key: 'interviews', label: 'Interviews Completed', minRank: 5 },
  { key: 'selected', label: 'Selected', minRank: 7 },
  { key: 'offersReleased', label: 'Offers Released', minRank: 8 },
  { key: 'joined', label: 'Joined', minRank: 9 },
];

function getLatestStatus(candidate) {
  const statusList = candidate?.Status || [];
  if (!statusList.length) return 'No Action Taken';
  return statusList[statusList.length - 1]?.Status || 'No Action Taken';
}

function getStatusRank(status) {
  return STATUS_RANK[status] || 1;
}

function isUploadedCandidate(candidate) {
  return candidate?.savedStatus === 'Uploaded';
}

function hasReachedStage(status, minRank) {
  return getStatusRank(status) >= minRank;
}

function isRejectedStatus(status) {
  return REJECTED_STATUSES.has(status);
}

function getRejectionStageLabel(status) {
  return REJECTION_STAGE_LABELS[status] || status || 'Rejected';
}

function isActiveCandidate(candidate) {
  if (!isUploadedCandidate(candidate)) return false;
  return !isRejectedStatus(getLatestStatus(candidate));
}

function findLatestRejectionEntry(candidate) {
  const statusList = candidate?.Status || [];
  for (let index = statusList.length - 1; index >= 0; index -= 1) {
    const entry = statusList[index];
    if (entry?.Status && isRejectedStatus(entry.Status)) {
      return entry;
    }
  }
  return null;
}

function getCandidateRejectionDetails(candidate) {
  const currentStatus = getLatestStatus(candidate);
  if (!isRejectedStatus(currentStatus)) return null;

  if (candidate?.rejectionStage) {
    return {
      rejectionStage: candidate.rejectionStage,
      rejectedDate: candidate.rejectedDate || null,
      rejectedBy: candidate.rejectedBy || '',
      rejectedByName: candidate.rejectedByName || candidate.rejectedBy || '—',
      rejectionReason: candidate.rejectionReason || candidate.remark || '',
      currentStatus,
    };
  }

  const rejectionEntry = findLatestRejectionEntry(candidate);
  if (!rejectionEntry) {
    return {
      rejectionStage: getRejectionStageLabel(currentStatus),
      rejectedDate: null,
      rejectedBy: '',
      rejectedByName: '—',
      rejectionReason: candidate?.remark || '',
      currentStatus,
    };
  }

  return {
    rejectionStage: getRejectionStageLabel(rejectionEntry.Status),
    rejectedDate: rejectionEntry.Date || null,
    rejectedBy: '',
    rejectedByName: '—',
    rejectionReason: rejectionEntry.Remark || candidate?.remark || '',
    currentStatus,
  };
}

function isJoinedStatus(status) {
  return JOINED_STATUSES.has(status);
}

function hasOfferStatus(status, candidate) {
  const offerInHand = String(candidate?.offerInHand || '').toLowerCase();
  return offerInHand === 'yes' || OFFER_STATUSES.has(status) || getStatusRank(status) >= 8;
}

function parseInterviewDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseCandidateDate(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.getFullYear() < 1971) return null;
  return parsed;
}

function startOfDay(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function getCandidateUploadedOn(candidate) {
  return parseCandidateDate(candidate?.uploadedOn) || parseCandidateDate(candidate?.date);
}

function isValidStatusActionEntry(entry) {
  const status = entry?.Status;
  return Boolean(status && status !== 'No Action Taken');
}

function getLatestStatusActionDate(candidate) {
  const statusList = candidate?.Status || [];
  let latest = null;

  statusList.forEach((entry) => {
    if (!isValidStatusActionEntry(entry)) return;
    const actionDate = parseCandidateDate(entry?.Date);
    if (!actionDate) return;
    if (!latest || actionDate > latest) latest = actionDate;
  });

  return latest;
}

function getNoActionReferenceDate(candidate) {
  return getLatestStatusActionDate(candidate) || getCandidateUploadedOn(candidate);
}

function isNoActionTakenCandidate(candidate, now = new Date()) {
  const referenceDate = getNoActionReferenceDate(candidate);
  if (!referenceDate) return false;

  const referenceDay = startOfDay(referenceDate);
  const today = startOfDay(now);
  const daysSinceReference = Math.floor((today - referenceDay) / (24 * 60 * 60 * 1000));
  return daysSinceReference >= 2;
}

module.exports = {
  REJECTED_STATUSES,
  REJECTION_STAGE_LABELS,
  JOINED_STATUSES,
  FUNNEL_STAGES,
  getLatestStatus,
  getStatusRank,
  isUploadedCandidate,
  hasReachedStage,
  isRejectedStatus,
  getRejectionStageLabel,
  isActiveCandidate,
  findLatestRejectionEntry,
  getCandidateRejectionDetails,
  isJoinedStatus,
  hasOfferStatus,
  parseInterviewDate,
  isNoActionTakenCandidate,
};
