const assert = require('assert');
const {
  createCandidateStatusUpdateService,
  CandidateStatusUpdateError,
} = require('./candidateStatusUpdate.service');

function userQuery(employeeName) {
  return {
    select() {
      return this;
    },
    lean: async () => (employeeName ? { EmployeeName: employeeName } : null),
  };
}

function createHarness({ found = true, employeeName = 'Ada Lovelace', notifyError = null } = {}) {
  const writes = [];
  const notifications = [];
  const service = createCandidateStatusUpdateService({
    CandidateModel: {
      async findOneAndUpdate(filter, update) {
        writes.push({ filter, update });
        if (!found || filter['candidates._id'] === 'missing') return null;
        const entry = update.$push['candidates.$.Status'];
        return {
          reqId: 'req-1',
          candidates: {
            id: () => ({
              _id: filter['candidates._id'],
              Status: [{ ...entry, _id: 'status-1' }],
            }),
          },
        };
      },
    },
    UserModel: {
      findById() {
        return userQuery(employeeName);
      },
    },
    createStatusRemarkNotifications: async (payload) => {
      if (notifyError) throw notifyError;
      notifications.push(payload);
      return { created: 1 };
    },
  });
  return { service, writes, notifications };
}

(async () => {
  const harness = createHarness();

  await assert.rejects(
    () => harness.service.appendCandidateStatusHistory({ candidateId: 'c1', remark: 'note' }),
    (error) => error instanceof CandidateStatusUpdateError && error.code === 'STATUS_REQUIRED',
  );

  await assert.rejects(
    () => harness.service.appendCandidateStatusHistory({
      candidateId: 'c1',
      status: 'HR Round',
      remark: '   ',
    }),
    (error) => error.code === 'REMARK_REQUIRED'
      && error.message === 'Remark is required when updating status.',
  );

  await assert.rejects(
    () => harness.service.appendCandidateStatusHistory({
      candidateId: 'c1',
      status: 'Candidate Declined',
      remark: '',
    }),
    (error) => error.code === 'REMARK_REQUIRED'
      && error.message === 'Remark is required when status is Candidate Declined.',
  );

  await assert.rejects(
    () => harness.service.appendCandidateStatusHistory({
      candidateId: 'c1',
      status: 'L1 Schedule',
      remark: 'Scheduled',
    }),
    (error) => error.code === 'INTERVIEW_DATE_REQUIRED',
  );

  const released = await harness.service.appendCandidateStatusHistory({
    candidateId: 'candidate-1',
    status: 'Offer Released',
    remark: '',
    notificationActorId: 'user-1',
  });
  assert.strictEqual(released.appended, true);
  assert.strictEqual(released.status, 'Offer Released');
  const releasedUpdate = harness.writes[0].update;
  assert.strictEqual(releasedUpdate.$push['candidates.$.Status'].Status, 'Offer Released');
  assert.strictEqual(releasedUpdate.$push['candidates.$.Status'].Remark, '');
  assert.strictEqual(releasedUpdate.$push['candidates.$.Status'].Remarks, undefined);
  assert.strictEqual(releasedUpdate.$set['candidates.$.remark'], '');
  assert.strictEqual(harness.notifications.length, 1);
  assert.strictEqual(harness.notifications[0].status, 'Offer Released');

  const preserved = createHarness();
  await preserved.service.appendCandidateStatusHistory({
    candidateId: 'candidate-1',
    status: 'Offer Accepted',
    remark: '',
    notificationActorId: 'user-1',
    preserveExistingRemarkWhenEmpty: true,
  });
  assert.strictEqual(preserved.writes[0].update.$set, undefined);
  assert.strictEqual(preserved.writes[0].update.$push['candidates.$.Status'].Status, 'Offer Accepted');

  const declined = createHarness();
  await declined.service.appendCandidateStatusHistory({
    candidateId: 'candidate-1',
    status: 'Candidate Declined',
    remark: '  Took another offer  ',
    rejectionActorId: '507f1f77bcf86cd799439011',
    notificationActorId: '507f1f77bcf86cd799439011',
    actorName: 'Fallback Name',
  });
  const declinedSet = declined.writes[0].update.$set;
  assert.strictEqual(declinedSet['candidates.$.remark'], 'Took another offer');
  assert.strictEqual(declinedSet['candidates.$.rejectionStage'], 'Offer Declined');
  assert.strictEqual(declinedSet['candidates.$.rejectedBy'], '507f1f77bcf86cd799439011');
  assert.strictEqual(declinedSet['candidates.$.rejectedByName'], 'Ada Lovelace');
  assert.strictEqual(declinedSet['candidates.$.rejectionReason'], 'Took another offer');
  assert.ok(declinedSet['candidates.$.rejectedDate'] instanceof Date);
  assert.deepStrictEqual(
    declined.writes[0].update.$push['candidates.$.Status'].Remarks.map((item) => item.text),
    ['Took another offer'],
  );

  const unnamed = createHarness({ employeeName: '' });
  await unnamed.service.appendCandidateStatusHistory({
    candidateId: 'candidate-1',
    status: 'Candidate Declined',
    remark: 'No show',
    rejectionActorId: 'actor-1',
    actorName: 'Fallback Name',
  });
  assert.strictEqual(unnamed.writes[0].update.$set['candidates.$.rejectedByName'], 'Fallback Name');

  const interview = createHarness();
  await interview.service.appendCandidateStatusHistory({
    candidateId: 'candidate-1',
    status: 'L2 Schedule',
    remark: 'Panel confirmed',
    interviewDate: '2026-11-20',
    interviewTime: '10:30',
  });
  assert.strictEqual(interview.writes[0].update.$set['candidates.$.interviewDate'], '2026-11-20');
  assert.strictEqual(interview.writes[0].update.$set['candidates.$.interviewTime'], '10:30');
  assert.strictEqual(interview.notifications.length, 0);

  const missing = createHarness({ found: false });
  await assert.rejects(
    () => missing.service.appendCandidateStatusHistory({
      candidateId: 'missing',
      status: 'Joined',
      remark: '',
    }),
    (error) => error.code === 'CANDIDATE_NOT_FOUND'
      && error.message === 'Candidate not found in any main document',
  );

  const noisy = createHarness({ notifyError: new Error('mail down') });
  const joined = await noisy.service.appendCandidateStatusHistory({
    candidateId: 'candidate-1',
    status: 'Joined',
    remark: 'Started',
    notificationActorId: 'user-1',
  });
  assert.strictEqual(joined.status, 'Joined');

  const repeated = createHarness();
  await repeated.service.appendCandidateStatusHistory({
    candidateId: 'candidate-1',
    status: 'Offer Accepted',
    remark: 'Confirmed',
  });
  await repeated.service.appendCandidateStatusHistory({
    candidateId: 'candidate-1',
    status: 'Offer Accepted',
    remark: 'Confirmed again',
  });
  assert.strictEqual(repeated.writes.length, 2);

  console.log('candidateStatusUpdate.service.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
