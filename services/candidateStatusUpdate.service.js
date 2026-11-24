const CandidateModel = require('../models/Candidate');
const NewUser = require('../models/User');
const { isRejectedStatus, getRejectionStageLabel } = require('../utils/candidateStatusMap');
const { createStatusRemarkNotifications } = require('./statusRemarkNotification.service');
const logger = require('../utils/logger');

const INTERVIEW_SCHEDULE_STATUSES = ['L1 Schedule', 'L2 Schedule', 'L3 Schedule'];
const REMARK_OPTIONAL_STATUSES = new Set([
  'Offer Released',
  'Offer Accepted',
  'Onboard Confirmation',
  'Joined',
]);

class CandidateStatusUpdateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CandidateStatusUpdateError';
    this.code = code;
  }
}

function createCandidateStatusUpdateService(deps = {}) {
  const candidates = deps.CandidateModel || CandidateModel;
  const users = deps.UserModel || NewUser;
  const notifyStatusRemark = deps.createStatusRemarkNotifications || createStatusRemarkNotifications;

  async function appendCandidateStatusHistory({
    candidateId,
    status,
    remark,
    interviewDate,
    interviewTime,
    rejectionActorId,
    notificationActorId,
    actorName,
    preserveExistingRemarkWhenEmpty = false,
  } = {}) {
    if (!status) {
      throw new CandidateStatusUpdateError('Status is required', 'STATUS_REQUIRED');
    }

    const trimmedRemark = String(remark ?? '').trim();
    if (!trimmedRemark && !REMARK_OPTIONAL_STATUSES.has(status)) {
      throw new CandidateStatusUpdateError(
        status === 'Candidate Declined'
          ? 'Remark is required when status is Candidate Declined.'
          : 'Remark is required when updating status.',
        'REMARK_REQUIRED',
      );
    }

    if (INTERVIEW_SCHEDULE_STATUSES.includes(status) && !interviewDate) {
      throw new CandidateStatusUpdateError(
        'Interview date is required when status is L1 Schedule, L2 Schedule, or L3 Schedule.',
        'INTERVIEW_DATE_REQUIRED',
      );
    }

    const statusEntry = {
      Status: status,
      Date: new Date(),
      Remark: trimmedRemark,
    };
    if (trimmedRemark) {
      statusEntry.Remarks = [{ text: trimmedRemark, createdAt: new Date() }];
    }

    const updateOps = {
      $push: { 'candidates.$.Status': statusEntry },
    };
    if (!preserveExistingRemarkWhenEmpty || trimmedRemark) {
      updateOps.$set = { 'candidates.$.remark': trimmedRemark };
    }

    if (interviewDate) {
      updateOps.$set = updateOps.$set || {};
      updateOps.$set['candidates.$.interviewDate'] = interviewDate;
      updateOps.$set['candidates.$.interviewTime'] = interviewTime || '';
    }

    if (isRejectedStatus(status)) {
      const rejectedByUser = rejectionActorId
        ? await users.findById(rejectionActorId).select('EmployeeName').lean()
        : null;
      const rejectedByName = rejectedByUser?.EmployeeName || String(actorName || '');
      updateOps.$set = updateOps.$set || {};
      updateOps.$set['candidates.$.rejectionStage'] = getRejectionStageLabel(status);
      updateOps.$set['candidates.$.rejectedDate'] = new Date();
      updateOps.$set['candidates.$.rejectedBy'] = rejectionActorId ? String(rejectionActorId) : '';
      updateOps.$set['candidates.$.rejectedByName'] = rejectedByName;
      updateOps.$set['candidates.$.rejectionReason'] = trimmedRemark;
    }

    const updatedMain = await candidates.findOneAndUpdate(
      { 'candidates._id': candidateId },
      updateOps,
      { new: true },
    );
    if (!updatedMain) {
      throw new CandidateStatusUpdateError(
        'Candidate not found in any main document',
        'CANDIDATE_NOT_FOUND',
      );
    }

    const updatedCandidate = updatedMain.candidates.id(candidateId);
    const latestStatusEntry = updatedCandidate?.Status?.length
      ? updatedCandidate.Status[updatedCandidate.Status.length - 1]
      : null;
    const actorId = notificationActorId || '';
    if (latestStatusEntry && actorId) {
      try {
        await notifyStatusRemark({
          actorId,
          candidate: updatedCandidate,
          mainDocument: updatedMain,
          requirementId: updatedMain.reqId,
          status,
          remark: trimmedRemark,
          statusEntryId: latestStatusEntry._id,
        });
      } catch (notifyError) {
        logger.error('Status remark notification failed:', notifyError);
      }
    }

    return {
      appended: true,
      status,
      candidate: updatedCandidate,
      mainDocument: updatedMain,
    };
  }

  return { appendCandidateStatusHistory };
}

const { appendCandidateStatusHistory } = createCandidateStatusUpdateService();

module.exports = {
  CandidateStatusUpdateError,
  REMARK_OPTIONAL_STATUSES,
  createCandidateStatusUpdateService,
  appendCandidateStatusHistory,
};
