const assert = require('assert');
const {
  evaluateMonitorCandidate,
  computeTodayMonitorPayload,
} = require('./todayMonitor.service');

const NOW = new Date('2026-10-12T10:00:00+05:30');

function candidateRow({
  id = 'c1',
  reqId = 'r1',
  status = 'Ornnova Screen Selected',
  statusDate = '2026-10-12T06:00:00+05:30',
  uploadedOn = '2026-10-12T06:00:00+05:30',
  interviewDate = '',
  savedStatus = 'Uploaded',
  requirementtype = 'High',
} = {}) {
  return {
    reqId,
    recruiterIds: ['u1'],
    candidate: {
      _id: id,
      firstName: 'Test',
      lastName: 'User',
      savedStatus,
      uploadedOn,
      interviewDate,
      Status: [{ Status: status, Date: statusDate }],
    },
    req: { _id: reqId, requirementtype, client: 'ADA', regId: '2279', role: 'Dev' },
  };
}

function mapsFor(row) {
  const reqMap = new Map([[row.reqId, row.req]]);
  return reqMap;
}

function evalRow(overrides) {
  const row = candidateRow(overrides);
  return evaluateMonitorCandidate(row, mapsFor(row), NOW);
}

assert.ok(evalRow({ status: 'No Action Taken' }).reasons.includes('uploaded_today'), 'uploaded today');
assert.ok(evalRow({
  uploadedOn: '2026-10-11T06:00:00+05:30',
  status: 'Shared with Client',
  statusDate: '2026-10-12T08:00:00+05:30',
}).reasons.includes('status_updated_today'), 'status updated today');

const interview = evalRow({
  uploadedOn: '2026-10-01T06:00:00+05:30',
  statusDate: '2026-10-01T06:00:00+05:30',
  status: 'L1 Schedule',
  interviewDate: '2026-10-12',
});
assert.ok(interview.reasons.includes('interview_today'), 'interview today');
assert.strictEqual(interview.monitorPriority, 'high');

assert.strictEqual(evalRow({
  uploadedOn: '2026-10-01T06:00:00+05:30',
  statusDate: '2026-10-01T06:00:00+05:30',
  status: 'L1 Schedule',
  interviewDate: '2026-10-11',
}), null, 'interview yesterday excluded');

assert.strictEqual(evalRow({
  uploadedOn: '2026-10-01T06:00:00+05:30',
  statusDate: '2026-10-01T06:00:00+05:30',
  status: 'L1 Schedule',
  interviewDate: '2026-10-13',
}), null, 'interview tomorrow excluded');

assert.strictEqual(evalRow({
  uploadedOn: '2026-09-01T06:00:00+05:30',
  statusDate: '2026-09-01T06:00:00+05:30',
  status: 'Ornnova Screen Selected',
}), null, 'older pending without today activity excluded');

const offer = evalRow({
  uploadedOn: '2026-10-12T06:00:00+05:30',
  status: 'Offer Released',
  statusDate: '2026-10-12T06:00:00+05:30',
});
assert.ok(offer.reasons.includes('offer_stage'), 'offer with today activity');

assert.strictEqual(evalRow({
  uploadedOn: '2026-09-01T06:00:00+05:30',
  statusDate: '2026-09-01T06:00:00+05:30',
  status: 'Offer Accepted',
}), null, 'historical offer excluded');

assert.strictEqual(evalRow({ status: 'Joined' }), null, 'Joined excluded');
assert.strictEqual(evalRow({ status: 'Rejected' }), null, 'Rejected excluded');
assert.strictEqual(evalRow({ requirementtype: 'Closed' }), null, 'Closed requirement excluded');

const payload = computeTodayMonitorPayload(
  [
    candidateRow({ id: 'a', reqId: 'r1' }),
    candidateRow({ id: 'b', reqId: 'r1', status: 'L1 Schedule', interviewDate: '2026-10-12', uploadedOn: '2026-10-01', statusDate: '2026-10-01' }),
  ],
  new Map([
    ['r1', { _id: 'r1', requirementtype: 'High', client: 'ADA', regId: '2279', role: 'Dev' }],
  ]),
  new Map(),
  { requirementIds: new Set(['r1']), recruiterIds: null },
  () => true,
  {
    formatInterviewLabel: () => '—',
    resolveRecruiterName: () => 'Supriya',
  },
  NOW,
);

assert.strictEqual(payload.filterBuckets.total.requirementIds.length, 1, 'deduped requirement');
assert.strictEqual(payload.filterBuckets.total.candidatesByRequirement.r1.length, 2, 'both candidates kept');
assert.strictEqual(payload.summary.total, 2);
assert.ok(payload.summary.interviewsToday === 1);

console.log('todayMonitor.service.test.js passed');
