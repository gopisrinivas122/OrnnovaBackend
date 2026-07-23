const NewRequirment = require('../models/Requirement');
const NewUser = require('../models/User');
const CandidateModel = require('../models/Candidate');
const {
  flattenUploadedCandidates,
  buildRequirementMap,
} = require('./adminAnalytics.service');
const {
  getLatestStatus,
  parseInterviewDate,
} = require('../utils/candidateStatusMap');

const PENDING_STATUSES = new Set([
  'Ornnova Screen Selected',
  'Shared with Client',
  'L1 Schedule',
  'L1 Pending',
  'L1 Selected',
  'L2 Schedule',
  'L2 Pending',
  'L2 Selected',
  'Onboard Confirmation',
  'Offer Released',
  'Offer Accepted',
]);

function isSameDay(value, reference = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return (
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  );
}

function getLastStatusDate(candidate) {
  const statusList = candidate?.Status || [];
  if (!statusList.length) return null;
  return statusList[statusList.length - 1]?.Date || null;
}

function formatInterviewLabel(interviewDate, interviewTime) {
  if (!interviewDate) return '—';
  const parsed = parseInterviewDate(interviewDate);
  if (!parsed) return '—';
  const dateLabel = parsed.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  return interviewTime ? `${dateLabel} ${interviewTime}` : dateLabel;
}

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

function buildScope(user, requirements = []) {
  if (!user) {
    return { requirementIds: new Set(), recruiterIds: new Set() };
  }

  if (user.UserType === 'Admin') {
    return {
      requirementIds: new Set(requirements.map((req) => req._id.toString())),
      recruiterIds: null,
    };
  }

  if (user.UserType === 'TeamLead') {
    const clientIds = new Set((user.Clients || []).map(String));
    const assignedReqIds = new Set((user.Requirements || []).map(String));
    const recruiterIds = new Set([user._id.toString(), ...(user.Team || []).map(String)]);
    const requirementIds = new Set();

    requirements.forEach((req) => {
      const reqId = req._id.toString();
      if (clientIds.has(String(req.clientId)) || assignedReqIds.has(reqId)) {
        requirementIds.add(reqId);
      }
    });

    return { requirementIds, recruiterIds };
  }

  const requirementIds = new Set((user.Requirements || []).map(String));
  return {
    requirementIds,
    recruiterIds: new Set([user._id.toString()]),
  };
}

function rowInScope(row, scope) {
  if (!scope.requirementIds.has(row.reqId)) return false;
  if (!scope.recruiterIds) return true;
  return row.recruiterIds.some((id) => scope.recruiterIds.has(id));
}

function buildMonitorItem(row, reqMap, userMap, reason, priority) {
  const req = reqMap.get(row.reqId);
  const status = getLatestStatus(row.candidate);
  const name = `${row.candidate.firstName || ''} ${row.candidate.lastName || ''}`.trim();

  return {
    candidateId: row.candidate._id?.toString(),
    candidateName: name || '—',
    client: req?.client || '—',
    role: row.candidate.role || req?.role || '—',
    regId: req?.regId || row.reqId,
    requirementId: row.reqId,
    status,
    recruiter: resolveRecruiterName(row, userMap),
    interviewDate: row.candidate.interviewDate || '',
    interviewTime: row.candidate.interviewTime || '',
    interviewLabel: formatInterviewLabel(row.candidate.interviewDate, row.candidate.interviewTime),
    reason,
    priority,
  };
}

function computeTodayMonitor(rows, reqMap, userMap, scope) {
  const today = new Date();
  const items = [];
  const seen = new Set();

  const addItem = (row, reason, priority) => {
    const key = `${row.candidate._id}-${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(buildMonitorItem(row, reqMap, userMap, reason, priority));
  };

  rows.forEach((row) => {
    if (!rowInScope(row, scope)) return;

    const status = getLatestStatus(row.candidate);
    const uploadedToday = isSameDay(row.candidate.uploadedOn, today);
    const statusUpdatedToday = isSameDay(getLastStatusDate(row.candidate), today);
    const interviewToday = isSameDay(parseInterviewDate(row.candidate.interviewDate), today);

    if (uploadedToday) addItem(row, 'uploaded_today', 'medium');
    if (statusUpdatedToday) addItem(row, 'status_updated_today', 'medium');
    if (interviewToday) addItem(row, 'interview_today', 'high');
    if (PENDING_STATUSES.has(status) && !uploadedToday && !statusUpdatedToday) {
      addItem(row, 'pending_action', 'high');
    }
    if (status === 'Offer Released' || status === 'Offer Accepted') {
      addItem(row, 'offer_stage', 'high');
    }
  });

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

function computeUpcomingInterviewsList(rows, reqMap, userMap, scope, days = 7) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + days);
  end.setHours(23, 59, 59, 999);

  return rows
    .filter((row) => rowInScope(row, scope))
    .map((row) => {
      const interviewDate = parseInterviewDate(row.candidate.interviewDate);
      if (!interviewDate) return null;
      if (interviewDate < now || interviewDate > end) return null;

      const req = reqMap.get(row.reqId);
      const name = `${row.candidate.firstName || ''} ${row.candidate.lastName || ''}`.trim();

      return {
        candidateId: row.candidate._id?.toString(),
        candidateName: name || '—',
        client: req?.client || '—',
        role: row.candidate.role || req?.role || '—',
        regId: req?.regId || row.reqId,
        requirementId: row.reqId,
        status: getLatestStatus(row.candidate),
        recruiter: resolveRecruiterName(row, userMap),
        interviewDate: interviewDate.toISOString(),
        interviewTime: row.candidate.interviewTime || '',
        interviewDateLabel: formatInterviewLabel(row.candidate.interviewDate, row.candidate.interviewTime),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.interviewDate) - new Date(b.interviewDate));
}

function computeNotifications(rows, reqMap, userMap, scope, user) {
  const notifications = [];
  const today = new Date();

  const monitorItems = computeTodayMonitor(rows, reqMap, userMap, scope);
  const highPriority = monitorItems.filter((item) => item.priority === 'high').length;
  if (monitorItems.length > 0) {
    notifications.push({
      id: 'today-monitor',
      type: 'monitor',
      title: `${monitorItems.length} profile(s) to monitor today`,
      message: highPriority > 0
        ? `${highPriority} need urgent follow-up (interviews, offers, or pending action).`
        : 'Review uploaded and updated candidates for today.',
      link: '/work/today',
      createdAt: today.toISOString(),
      unread: true,
    });
  }

  const interviewsToday = computeUpcomingInterviewsList(rows, reqMap, userMap, scope, 1)
    .filter((item) => isSameDay(parseInterviewDate(item.interviewDate), today));
  if (interviewsToday.length > 0) {
    notifications.push({
      id: 'interviews-today',
      type: 'interview',
      title: `${interviewsToday.length} interview(s) scheduled today`,
      message: interviewsToday.map((item) => `${item.candidateName} — ${item.client}`).slice(0, 3).join(', '),
      link: '/work/interviews',
      createdAt: today.toISOString(),
      unread: true,
    });
  }

  const upcoming = computeUpcomingInterviewsList(rows, reqMap, userMap, scope, 3);
  if (upcoming.length > interviewsToday.length) {
    notifications.push({
      id: 'interviews-upcoming',
      type: 'interview',
      title: `${upcoming.length} upcoming interview(s) in next 3 days`,
      message: 'Open the interview schedule to review dates and times.',
      link: '/work/interviews',
      createdAt: today.toISOString(),
      unread: true,
    });
  }

  if (user?.UserType === 'TeamLead') {
    const uploadedToday = rows.filter(
      (row) => rowInScope(row, scope) && isSameDay(row.candidate.uploadedOn, today)
    ).length;
    if (uploadedToday > 0) {
      notifications.push({
        id: 'team-uploads-today',
        type: 'upload',
        title: `${uploadedToday} new team upload(s) today`,
        message: 'Check candidate submissions from your recruiters.',
        link: '/team/profiles',
        createdAt: today.toISOString(),
        unread: true,
      });
    }
  }

  return notifications.slice(0, 8);
}

async function loadWorkflowData() {
  const [requirements, users, candidateDocs] = await Promise.all([
    NewRequirment.find().lean(),
    NewUser.find().lean(),
    CandidateModel.find().lean(),
  ]);

  const rows = flattenUploadedCandidates(candidateDocs);
  const reqMap = buildRequirementMap(requirements);
  const userMap = buildUserMap(users);

  return { requirements, users, rows, reqMap, userMap };
}

async function getTodayMonitorForUser(userId) {
  const { requirements, users, rows, reqMap, userMap } = await loadWorkflowData();
  const user = users.find((item) => item._id.toString() === userId);
  if (!user) {
    return { status: 'Error', msg: 'User not found', items: [], summary: {} };
  }

  const scope = buildScope(user, requirements);
  const items = computeTodayMonitor(rows, reqMap, userMap, scope);

  return {
    status: 'Success',
    generatedAt: new Date().toISOString(),
    role: user.UserType,
    summary: {
      total: items.length,
      highPriority: items.filter((item) => item.priority === 'high').length,
      interviewsToday: items.filter((item) => item.reason === 'interview_today').length,
      pendingAction: items.filter((item) => item.reason === 'pending_action').length,
      offerStage: items.filter((item) => item.reason === 'offer_stage').length,
    },
    items,
  };
}

async function getUpcomingInterviewsForUser(userId, days = 7) {
  const { requirements, users, rows, reqMap, userMap } = await loadWorkflowData();
  const user = users.find((item) => item._id.toString() === userId);
  if (!user) {
    return { status: 'Error', msg: 'User not found', interviews: [] };
  }

  const scope = buildScope(user, requirements);
  const interviews = computeUpcomingInterviewsList(rows, reqMap, userMap, scope, days);

  return {
    status: 'Success',
    generatedAt: new Date().toISOString(),
    role: user.UserType,
    days,
    total: interviews.length,
    interviews,
  };
}

async function getNotificationsForUser(userId) {
  const { requirements, users, rows, reqMap, userMap } = await loadWorkflowData();
  const user = users.find((item) => item._id.toString() === userId);
  if (!user) {
    return { status: 'Error', msg: 'User not found', notifications: [], unreadCount: 0 };
  }

  const scope = buildScope(user, requirements);
  const notifications = computeNotifications(rows, reqMap, userMap, scope, user);

  return {
    status: 'Success',
    generatedAt: new Date().toISOString(),
    unreadCount: notifications.filter((item) => item.unread).length,
    notifications,
  };
}

module.exports = {
  getTodayMonitorForUser,
  getUpcomingInterviewsForUser,
  getNotificationsForUser,
  formatInterviewLabel,
};
