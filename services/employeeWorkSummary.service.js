const NewRequirment = require('../models/Requirement');
const NewUser = require('../models/User');
const CandidateModel = require('../models/Candidate');
const { isValidObjectId } = require('../middleware/validateObjectId');
const { enrichRequirementsWithClientNames } = require('../utils/requirementClient');
const {
  flattenUploadedCandidates,
  buildRequirementMap,
  isDateInRange,
  isUploadedOnInRange,
  formatRequirementDrillDownRow,
  formatCandidateDrillDownRow,
} = require('./adminAnalytics.service');

const WORK_SUMMARY_METRICS = {
  reqsAssigned: 'reqsAssigned',
  profilesSourced: 'profilesSourced',
  ornnovaScreenSelected: 'ornnovaScreenSelected',
  l1Select: 'l1Select',
  l2Select: 'l2Select',
  joined: 'joined',
  declined: 'declined',
};

const STATUS_BY_METRIC = {
  [WORK_SUMMARY_METRICS.ornnovaScreenSelected]: 'Ornnova Screen Selected',
  [WORK_SUMMARY_METRICS.l1Select]: 'L1 Selected',
  [WORK_SUMMARY_METRICS.l2Select]: 'L2 Selected',
  [WORK_SUMMARY_METRICS.joined]: 'Joined',
  [WORK_SUMMARY_METRICS.declined]: 'Declined',
};

function sortStatusHistoryChronologically(statusHistory = []) {
  return [...statusHistory]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const dateDiff = new Date(a.entry?.Date || 0) - new Date(b.entry?.Date || 0);
      if (dateDiff !== 0) return dateDiff;
      if (a.entry?._id && b.entry?._id) {
        return String(a.entry._id).localeCompare(String(b.entry._id));
      }
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function candidateOwnedByUser(candidate, docRecruiterIds, userId) {
  const uid = String(userId);
  const candidateRecruiters = Array.isArray(candidate?.recruiterId)
    ? candidate.recruiterId.map(String)
    : [];
  if (candidateRecruiters.includes(uid)) return true;
  return (docRecruiterIds || []).map(String).includes(uid);
}

function getStatusHistory(candidate) {
  const list = Array.isArray(candidate?.Status) ? candidate.Status : [];
  return sortStatusHistoryChronologically(list);
}

function getStatusEventsInRange(candidate, statusLabel, startDate, endDate) {
  return getStatusHistory(candidate).filter((entry) => {
    if (entry?.Status !== statusLabel) return false;
    return isDateInRange(entry?.Date, startDate, endDate);
  });
}

function candidateHasStatusEventInRange(candidate, statusLabel, startDate, endDate) {
  return getStatusEventsInRange(candidate, statusLabel, startDate, endDate).length > 0;
}

function resolveUploadedOn(candidate) {
  return candidate?.uploadedOn || candidate?.date || null;
}

function profileSourcedByEmployeeInRange(row, employeeId, startDate, endDate) {
  if (!candidateOwnedByUser(row.candidate, row.recruiterIds, employeeId)) return false;
  return isUploadedOnInRange(resolveUploadedOn(row.candidate), startDate, endDate);
}

function countReqsAssignedForEmployee(requirements, employeeId, startDate, endDate) {
  let count = 0;
  requirements.forEach((req) => {
    (req.assignedMembers || []).forEach((member) => {
      if (String(member.userId) !== String(employeeId)) return;
      if (!isDateInRange(member.assignedDate, startDate, endDate)) return;
      count += 1;
    });
  });
  return count;
}

function listReqsAssignedForEmployee(requirements, employeeId, startDate, endDate) {
  const rows = [];
  requirements.forEach((req) => {
    (req.assignedMembers || []).forEach((member) => {
      if (String(member.userId) !== String(employeeId)) return;
      if (!isDateInRange(member.assignedDate, startDate, endDate)) return;
      rows.push({
        ...formatRequirementDrillDownRow(req),
        assignedDate: member.assignedDate || null,
      });
    });
  });
  return rows;
}

function formatStatusMetricRow(row, reqMap, statusLabel, eventDate) {
  const base = formatCandidateDrillDownRow(row, reqMap);
  return {
    ...base,
    status: statusLabel,
    statusEventDate: eventDate || null,
  };
}

function listProfilesSourcedForEmployee(rows, reqMap, employeeId, startDate, endDate) {
  return rows
    .filter((row) => profileSourcedByEmployeeInRange(row, employeeId, startDate, endDate))
    .map((row) => formatCandidateDrillDownRow(row, reqMap));
}

function listStatusMetricForEmployee(rows, reqMap, employeeId, metricKey, startDate, endDate) {
  const statusLabel = STATUS_BY_METRIC[metricKey];
  if (!statusLabel) return [];

  const results = [];
  rows.forEach((row) => {
    if (!candidateOwnedByUser(row.candidate, row.recruiterIds, employeeId)) return;
    const events = getStatusEventsInRange(row.candidate, statusLabel, startDate, endDate);
    if (!events.length) return;
    const latestEvent = events[events.length - 1];
    results.push(formatStatusMetricRow(row, reqMap, statusLabel, latestEvent?.Date || null));
  });
  return results;
}

function buildEmployeeSummaryRow(user, requirements, rows, reqMap, startDate, endDate) {
  const employeeId = user._id.toString();
  const metrics = {
    reqsAssigned: countReqsAssignedForEmployee(requirements, employeeId, startDate, endDate),
    profilesSourced: rows.filter((row) => profileSourcedByEmployeeInRange(row, employeeId, startDate, endDate)).length,
    ornnovaScreenSelected: 0,
    l1Select: 0,
    l2Select: 0,
    joined: 0,
    declined: 0,
  };

  rows.forEach((row) => {
    if (!candidateOwnedByUser(row.candidate, row.recruiterIds, employeeId)) return;

    Object.entries(STATUS_BY_METRIC).forEach(([metricKey, statusLabel]) => {
      if (candidateHasStatusEventInRange(row.candidate, statusLabel, startDate, endDate)) {
        metrics[metricKey] += 1;
      }
    });
  });

  return {
    employeeId,
    name: user.EmployeeName || '—',
    role: user.UserType === 'TeamLead' ? 'Team Lead' : 'Recruiter',
    ...metrics,
  };
}

function rowHasAnyActivity(summaryRow) {
  return (
    summaryRow.reqsAssigned > 0
    || summaryRow.profilesSourced > 0
    || summaryRow.ornnovaScreenSelected > 0
    || summaryRow.l1Select > 0
    || summaryRow.l2Select > 0
    || summaryRow.joined > 0
    || summaryRow.declined > 0
  );
}

function validateDateRange(startDate, endDate) {
  if (!startDate || !endDate) {
    return { ok: false, message: 'Start Date and End Date are required.' };
  }
  const from = new Date(startDate);
  const to = new Date(endDate);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { ok: false, message: 'Invalid date range.' };
  }
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  if (from > to) {
    return { ok: false, message: 'Start Date cannot be after End Date.' };
  }
  return { ok: true };
}

async function getEmployeeWorkSummary({ startDate, endDate, employeeId, metric } = {}) {
  const rangeCheck = validateDateRange(startDate, endDate);
  if (!rangeCheck.ok) {
    return { status: 'Error', msg: rangeCheck.message };
  }

  const normalizedMetric = metric ? String(metric).trim() : '';
  if (normalizedMetric && !WORK_SUMMARY_METRICS[normalizedMetric]) {
    return { status: 'Error', msg: 'Invalid metric.' };
  }

  const [rawRequirements, users, candidateDocs] = await Promise.all([
    NewRequirment.find().lean(),
    NewUser.find({ UserType: { $in: ['User', 'TeamLead'] } })
      .select('_id EmployeeName UserType')
      .lean(),
    CandidateModel.find().lean(),
  ]);

  const requirements = await enrichRequirementsWithClientNames(rawRequirements);
  const rows = flattenUploadedCandidates(candidateDocs);
  const reqMap = buildRequirementMap(requirements);

  const employeeOptions = users
    .map((user) => ({
      id: user._id.toString(),
      name: user.EmployeeName || '—',
      userType: user.UserType,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let scopedUsers = users;
  if (employeeId) {
    if (!isValidObjectId(employeeId)) {
      return { status: 'Error', msg: 'Invalid employee.' };
    }
    scopedUsers = users.filter((user) => user._id.toString() === String(employeeId));
    if (!scopedUsers.length) {
      return { status: 'Error', msg: 'Employee not found.' };
    }
  }

  if (normalizedMetric) {
    const targetId = employeeId || null;
    if (!targetId) {
      return { status: 'Error', msg: 'employeeId is required when requesting metric details.' };
    }

    let detailRows = [];
    if (normalizedMetric === WORK_SUMMARY_METRICS.reqsAssigned) {
      detailRows = listReqsAssignedForEmployee(requirements, targetId, startDate, endDate);
    } else if (normalizedMetric === WORK_SUMMARY_METRICS.profilesSourced) {
      detailRows = listProfilesSourcedForEmployee(rows, reqMap, targetId, startDate, endDate);
    } else {
      detailRows = listStatusMetricForEmployee(rows, reqMap, targetId, normalizedMetric, startDate, endDate);
    }

    const employee = scopedUsers[0];
    return {
      status: 'Success',
      period: { startDate, endDate },
      employeeOptions,
      detail: {
        metric: normalizedMetric,
        employeeId: targetId,
        employeeName: employee?.EmployeeName || '—',
        rows: detailRows,
      },
    };
  }

  const summaryRows = scopedUsers
    .map((user) => buildEmployeeSummaryRow(user, requirements, rows, reqMap, startDate, endDate))
    .sort((a, b) => a.name.localeCompare(b.name));

  const hasActivity = summaryRows.some(rowHasAnyActivity);

  return {
    status: 'Success',
    period: { startDate, endDate },
    employeeOptions,
    rows: summaryRows,
    hasActivity,
    filteredEmployeeId: employeeId || null,
  };
}

module.exports = {
  getEmployeeWorkSummary,
  WORK_SUMMARY_METRICS,
};
