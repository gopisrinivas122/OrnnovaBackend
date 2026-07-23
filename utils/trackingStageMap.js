const { parseInterviewDate } = require('./candidateStatusMap');

const TRACKING_STAGES = [
  { key: 'profiles_received', label: 'Profiles Received', icon: '👥', color: '#2563eb', kpi: true, flowOrder: 1 },
  { key: 'assessed', label: 'Assessed', icon: '📋', color: '#22c55e', kpi: false, flowOrder: 2 },
  { key: 'profiles_submitted', label: 'Profiles Submitted', icon: '📤', color: '#22c55e', kpi: true, flowOrder: 3 },
  { key: 'client_shortlisted', label: 'Client Shortlisted', icon: '🔍', color: '#8b5cf6', kpi: true, flowOrder: 4 },
  { key: 'l1_scheduled', label: 'L1 Scheduled', icon: '📅', color: '#14b8a6', kpi: false, flowOrder: 5 },
  { key: 'l1_cleared', label: 'L1 Cleared', icon: '✅', color: '#2563eb', kpi: true, flowOrder: 6 },
  { key: 'l2_scheduled', label: 'L2 Scheduled', icon: '🗓️', color: '#f59e0b', kpi: false, flowOrder: 7 },
  { key: 'l2_cleared', label: 'L2 Cleared', icon: '✔️', color: '#8b5cf6', kpi: true, flowOrder: 8 },
  { key: 'selected', label: 'Selected', icon: '⭐', color: '#f97316', kpi: false, flowOrder: 9 },
  { key: 'offers_released', label: 'Offers Released', icon: '📨', color: '#22c55e', kpi: true, flowOrder: 10 },
  { key: 'offers_accepted', label: 'Offers Accepted', icon: '🤝', color: '#2563eb', kpi: true, flowOrder: 11 },
  { key: 'joined', label: 'Joined', icon: '🧑‍💼', color: '#8b5cf6', kpi: true, flowOrder: 12 },
  { key: 'onboarded', label: 'Onboarded', icon: '🪪', color: '#14b8a6', kpi: true, flowOrder: 13 },
];

function hasInterviewDate(candidate) {
  return !!parseInterviewDate(candidate?.interviewDate);
}

function getLastStatusDate(candidate) {
  const statusList = candidate?.Status || [];
  if (!statusList.length) return null;
  return statusList[statusList.length - 1]?.Date || null;
}

function normalizePipelineStatus(status) {
  if (status === 'L1 Pending') return 'L1 Schedule';
  if (status === 'L2 Pending') return 'L2 Schedule';
  return status;
}

function isL1ScheduleStatus(status) {
  return status === 'L1 Schedule' || status === 'L1 Pending';
}

function isL2ScheduleStatus(status) {
  return status === 'L2 Schedule' || status === 'L2 Pending';
}

function matchesStage(stageKey, status, candidate) {
  switch (stageKey) {
    case 'profiles_received':
      return true;
    case 'assessed':
      return ['No Action Taken', 'Ornnova Screen Selected'].includes(status);
    case 'profiles_submitted':
      return status === 'Shared with Client';
    case 'client_shortlisted':
      return isL1ScheduleStatus(status) && !hasInterviewDate(candidate);
    case 'l1_scheduled':
      return isL1ScheduleStatus(status) && hasInterviewDate(candidate);
    case 'l1_cleared':
      return status === 'L1 Selected';
    case 'l2_scheduled':
      return isL2ScheduleStatus(status) && hasInterviewDate(candidate);
    case 'l2_cleared':
      return status === 'L2 Selected';
    case 'selected':
      return status === 'Selected';
    case 'offers_released':
      return ['Offer Released', 'Onboard Confirmation'].includes(status);
    case 'offers_accepted':
      return status === 'Offer Accepted';
    case 'joined':
      return status === 'On Boarded';
    case 'onboarded':
      return status === 'Onboarded';
    default:
      return false;
  }
}

function getStageByKey(stageKey) {
  return TRACKING_STAGES.find((stage) => stage.key === stageKey) || null;
}

function getKpiStages() {
  return TRACKING_STAGES.filter((stage) => stage.kpi);
}

function getFlowStages() {
  return [...TRACKING_STAGES].sort((a, b) => a.flowOrder - b.flowOrder);
}

function resolvePrimaryStage(status, candidate) {
  const stages = getFlowStages();
  let matched = stages[0];

  stages.forEach((stage) => {
    if (matchesStage(stage.key, status, candidate)) {
      matched = stage;
    }
  });

  return matched;
}

module.exports = {
  TRACKING_STAGES,
  matchesStage,
  getStageByKey,
  getKpiStages,
  getFlowStages,
  getLastStatusDate,
  resolvePrimaryStage,
};
