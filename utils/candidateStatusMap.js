const REJECTED_STATUSES = new Set([
  'Rejected',
  'Declined',
  'Client Rejected',
  'L1 Rejected',
  'L2 Rejected',
]);

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

module.exports = {
  REJECTED_STATUSES,
  JOINED_STATUSES,
  FUNNEL_STAGES,
  getLatestStatus,
  getStatusRank,
  isUploadedCandidate,
  hasReachedStage,
  isRejectedStatus,
  isJoinedStatus,
  hasOfferStatus,
  parseInterviewDate,
};
