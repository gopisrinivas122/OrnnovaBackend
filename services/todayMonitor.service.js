const { isSameISTDay, parseInstant } = require('../utils/istDate');
const { isRequirementWorkBlocked } = require('../utils/requirementType');
const {
  getLatestStatusByTimestamp,
  getLatestStatusActionDate,
  getCandidateUploadedOn,
  isUploadedCandidate,
  isRejectedStatus,
  isJoinedStatus,
  parseInterviewDate,
} = require('../utils/candidateStatusMap');

const PENDING_STATUSES = new Set([
  'Ornnova Screen Selected',
  'Shared with Client',
  'L1 Schedule',
  'L1 Pending',
  'L1 To be Schedule',
  'L1 Selected',
  'L2 Schedule',
  'L2 Pending',
  'L2 To be Schedule',
  'L2 Selected',
  'L3 Schedule',
  'L3 Pending',
  'L3 To be Schedule',
  'Onboard Confirmation',
  'Offer Released',
  'Offer Accepted',
]);

const OFFER_STATUSES = new Set(['Offer Released', 'Offer Accepted']);

const REASON_PRIORITY = [
  'interview_today',
  'offer_stage',
  'pending_action',
  'status_updated_today',
  'uploaded_today',
];

const FILTER_BUCKET_KEYS = [
  'total',
  'high_priority',
  'interviews_today',
  'pending_action',
  'offer_stage',
];

function isTerminalMonitorStatus(status) {
  return isRejectedStatus(status) || isJoinedStatus(status) || status === 'Joined';
}

/**
 * No SLA/overdue day threshold exists in the product. Follow-up is treated as due
 * today only when there is IST-today activity or an interview on today's IST date.
 */
function isFollowUpDueToday(flags) {
  return Boolean(flags.uploadedToday || flags.statusUpdatedToday || flags.interviewToday);
}

function pickPrimaryReason(reasons = []) {
  return REASON_PRIORITY.find((reason) => reasons.includes(reason)) || reasons[0] || '';
}

function resolveMonitorPriority(reasons = []) {
  if (reasons.some((reason) => ['interview_today', 'pending_action', 'offer_stage'].includes(reason))) {
    return 'high';
  }
  return 'medium';
}

function evaluateMonitorCandidate(row, reqMap, now = new Date()) {
  const req = reqMap.get(row.reqId);
  if (req && isRequirementWorkBlocked(req.requirementtype)) return null;

  const candidate = row.candidate;
  if (!isUploadedCandidate(candidate)) return null;

  const status = getLatestStatusByTimestamp(candidate);
  if (isTerminalMonitorStatus(status)) return null;

  const uploadedOn = getCandidateUploadedOn(candidate);
  const uploadedToday = uploadedOn ? isSameISTDay(uploadedOn, now) : false;
  const lastActionDate = getLatestStatusActionDate(candidate);
  const statusUpdatedToday = lastActionDate ? isSameISTDay(lastActionDate, now) : false;
  const interviewDate = parseInterviewDate(candidate.interviewDate);
  const interviewToday = interviewDate ? isSameISTDay(interviewDate, now) : false;

  const followUpDueToday = isFollowUpDueToday({
    uploadedToday,
    statusUpdatedToday,
    interviewToday,
  });
  const isOffer = OFFER_STATUSES.has(status);
  const isPendingPipeline = PENDING_STATUSES.has(status) && !isOffer;

  const reasons = [];
  if (uploadedToday) reasons.push('uploaded_today');
  if (statusUpdatedToday) reasons.push('status_updated_today');
  if (interviewToday) reasons.push('interview_today');
  if (isPendingPipeline && followUpDueToday) reasons.push('pending_action');
  if (isOffer && followUpDueToday) reasons.push('offer_stage');

  if (!reasons.length) return null;

  const primaryReason = pickPrimaryReason(reasons);
  const monitorPriority = resolveMonitorPriority(reasons);

  return {
    candidateId: candidate._id?.toString(),
    requirementId: row.reqId,
    reasons,
    primaryReason,
    monitorPriority,
    status,
    uploadedToday,
    statusUpdatedToday,
    interviewToday,
  };
}

function emptyBuckets() {
  const buckets = {};
  FILTER_BUCKET_KEYS.forEach((key) => {
    buckets[key] = {
      requirementIds: [],
      candidatesByRequirement: {},
    };
  });
  return buckets;
}

function addToBucket(buckets, bucketKey, evaluation) {
  const bucket = buckets[bucketKey];
  if (!bucket) return;

  const reqId = evaluation.requirementId;
  const candidateId = evaluation.candidateId;
  if (!reqId || !candidateId) return;

  if (!bucket.candidatesByRequirement[reqId]) {
    bucket.candidatesByRequirement[reqId] = [];
    bucket.requirementIds.push(reqId);
  }

  const existing = bucket.candidatesByRequirement[reqId];
  if (!existing.includes(candidateId)) {
    existing.push(candidateId);
  }
}

function buildFilterBuckets(evaluations = []) {
  const buckets = emptyBuckets();

  evaluations.forEach((evaluation) => {
    addToBucket(buckets, 'total', evaluation);

    if (evaluation.monitorPriority === 'high') {
      addToBucket(buckets, 'high_priority', evaluation);
    }
    if (evaluation.reasons.includes('interview_today')) {
      addToBucket(buckets, 'interviews_today', evaluation);
    }
    if (evaluation.reasons.includes('pending_action')) {
      addToBucket(buckets, 'pending_action', evaluation);
    }
    if (evaluation.reasons.includes('offer_stage')) {
      addToBucket(buckets, 'offer_stage', evaluation);
    }
  });

  return buckets;
}

function buildMonitorItem(row, reqMap, userMap, evaluation, formatInterviewLabel, resolveRecruiterName) {
  const req = reqMap.get(row.reqId);
  const name = `${row.candidate.firstName || ''} ${row.candidate.lastName || ''}`.trim();

  return {
    candidateId: evaluation.candidateId,
    candidateName: name || '—',
    client: req?.client || '—',
    role: row.candidate.role || req?.role || '—',
    regId: req?.regId || row.reqId,
    requirementId: row.reqId,
    status: evaluation.status,
    recruiter: resolveRecruiterName(row, userMap),
    interviewDate: row.candidate.interviewDate || '',
    interviewTime: row.candidate.interviewTime || '',
    interviewLabel: formatInterviewLabel(row.candidate.interviewDate, row.candidate.interviewTime),
    reason: evaluation.primaryReason,
    reasons: evaluation.reasons,
    priority: evaluation.monitorPriority,
  };
}

function computeTodayMonitorPayload(rows, reqMap, userMap, scope, rowInScope, helpers, now = new Date()) {
  const { formatInterviewLabel, resolveRecruiterName } = helpers;
  const evaluations = [];
  const evaluationByCandidate = new Map();

  rows.forEach((row) => {
    if (!rowInScope(row, scope)) return;
    const evaluation = evaluateMonitorCandidate(row, reqMap, now);
    if (!evaluation) return;

    const candidateKey = evaluation.candidateId;
    if (!candidateKey) return;

    const existing = evaluationByCandidate.get(candidateKey);
    if (!existing) {
      evaluationByCandidate.set(candidateKey, { row, evaluation });
      evaluations.push(evaluation);
      return;
    }

    const mergedReasons = [...new Set([...existing.evaluation.reasons, ...evaluation.reasons])];
    const merged = {
      ...existing.evaluation,
      reasons: mergedReasons,
      primaryReason: pickPrimaryReason(mergedReasons),
      monitorPriority: resolveMonitorPriority(mergedReasons),
    };
    existing.evaluation = merged;
    const index = evaluations.findIndex((item) => item.candidateId === candidateKey);
    if (index >= 0) evaluations[index] = merged;
  });

  const items = [];
  evaluationByCandidate.forEach(({ row, evaluation }) => {
    items.push(buildMonitorItem(row, reqMap, userMap, evaluation, formatInterviewLabel, resolveRecruiterName));
  });

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  const filterBuckets = buildFilterBuckets(evaluations);

  const uniqueTotal = new Set(evaluations.map((item) => item.candidateId));
  const summary = {
    total: uniqueTotal.size,
    highPriority: evaluations.filter((item) => item.monitorPriority === 'high').length,
    interviewsToday: evaluations.filter((item) => item.reasons.includes('interview_today')).length,
    pendingAction: evaluations.filter((item) => item.reasons.includes('pending_action')).length,
    offerStage: evaluations.filter((item) => item.reasons.includes('offer_stage')).length,
  };

  return { items, summary, filterBuckets, evaluations };
}

module.exports = {
  PENDING_STATUSES,
  OFFER_STATUSES,
  evaluateMonitorCandidate,
  computeTodayMonitorPayload,
  isFollowUpDueToday,
  isTerminalMonitorStatus,
  FILTER_BUCKET_KEYS,
};
