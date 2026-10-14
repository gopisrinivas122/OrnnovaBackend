const assert = require('assert');
const {
  buildVisibleRequirementIdSet,
  rowMatchesVisibleRequirement,
  rowOwnedByAllowedRecruiters,
  selectVisibleRequirementsForTeamLead,
  filterTeamLeadProfileRows,
  dedupeSourceProfileRows,
} = require('./sourceProfileSearch.service');

const visible = buildVisibleRequirementIdSet([
  { _id: 'req-1', regId: '1001' },
  { _id: 'req-2', regId: '1002' },
]);

assert.ok(rowMatchesVisibleRequirement({ reqId: 'req-1' }, visible));
assert.ok(rowMatchesVisibleRequirement({ reqId: '1002' }, visible));
assert.ok(!rowMatchesVisibleRequirement({ reqId: 'req-other' }, visible));

const allowed = new Set(['tl-1', 'recruiter-1']);
assert.ok(rowOwnedByAllowedRecruiters({
  recruiterIds: ['recruiter-1'],
  candidate: { recruiterId: ['recruiter-1'] },
}, allowed));
assert.ok(!rowOwnedByAllowedRecruiters({
  recruiterIds: ['other-tl'],
  candidate: { recruiterId: ['other-tl'] },
}, allowed));

const teamLead = {
  _id: 'tl-1',
  UserType: 'TeamLead',
  Requirements: ['req-assigned'],
  excludedRequirements: [],
};

const requirements = [
  { _id: 'req-created', createdBy: 'tl-1', uploadedBy: 'tl-1', regId: 'C1' },
  { _id: 'req-assigned', createdBy: 'admin', uploadedBy: 'admin', regId: 'A1' },
  { _id: 'req-other-tl', createdBy: 'tl-2', uploadedBy: 'tl-2', regId: 'O1' },
];

const visibleReqs = selectVisibleRequirementsForTeamLead(requirements, teamLead);
const visibleIds = visibleReqs.map((req) => String(req._id)).sort();
assert.deepStrictEqual(visibleIds, ['req-assigned', 'req-created']);
assert.ok(!visibleIds.includes('req-other-tl'), 'unrelated TL requirements are excluded');

const allowedRecruiters = new Set(['tl-1', 'recruiter-1']);
const visibleReqIds = buildVisibleRequirementIdSet(visibleReqs);

const rows = [
  {
    reqId: 'req-created',
    recruiterIds: ['tl-1'],
    candidate: {
      _id: 'c-created',
      firstName: 'Created',
      lastName: 'ByTl',
      recruiterId: ['tl-1'],
      uploadedOn: '2026-10-09T10:00:00.000Z',
    },
  },
  {
    reqId: 'req-assigned',
    recruiterIds: ['recruiter-1'],
    candidate: {
      _id: 'c-team',
      firstName: 'Team',
      lastName: 'Recruiter',
      recruiterId: ['recruiter-1'],
      uploadedOn: '2026-09-16T10:00:00.000Z',
    },
  },
  {
    reqId: 'req-assigned',
    recruiterIds: ['outsider'],
    candidate: {
      _id: 'c-outsider',
      firstName: 'Other',
      lastName: 'Recruiter',
      recruiterId: ['outsider'],
      uploadedOn: '2026-10-09T10:00:00.000Z',
    },
  },
  {
    reqId: 'req-other-tl',
    recruiterIds: ['recruiter-1'],
    candidate: {
      _id: 'c-other-req',
      firstName: 'Wrong',
      lastName: 'Req',
      recruiterId: ['recruiter-1'],
      uploadedOn: '2026-10-09T10:00:00.000Z',
    },
  },
  {
    reqId: 'req-created',
    recruiterIds: ['tl-1'],
    candidate: {
      _id: 'c-created',
      firstName: 'Created',
      lastName: 'ByTl',
      recruiterId: ['tl-1'],
      uploadedOn: '2026-10-09T10:00:00.000Z',
    },
  },
];

const scoped = filterTeamLeadProfileRows(rows, {
  visibleReqIds,
  allowedRecruiterIds: allowedRecruiters,
});
assert.strictEqual(scoped.length, 3, 'created + team + duplicate created row before dedupe');
assert.ok(scoped.every((row) => row.candidate._id !== 'c-outsider'));
assert.ok(scoped.every((row) => row.candidate._id !== 'c-other-req'));

const unique = dedupeSourceProfileRows(scoped);
assert.strictEqual(unique.length, 2, 'duplicate created profile collapsed to one row');
assert.deepStrictEqual(
  unique.map((row) => row.candidate._id).sort(),
  ['c-created', 'c-team'],
);

const octoberOnly = filterTeamLeadProfileRows(rows, {
  visibleReqIds,
  allowedRecruiterIds: allowedRecruiters,
  fromDate: '2026-10-01',
  toDate: '2026-10-12',
});
assert.ok(octoberOnly.every((row) => row.candidate._id === 'c-created'));
assert.ok(!octoberOnly.some((row) => row.candidate._id === 'c-team'), 'date filter still applies to listing');

const allDates = filterTeamLeadProfileRows(rows, {
  visibleReqIds,
  allowedRecruiterIds: allowedRecruiters,
});
assert.ok(allDates.some((row) => row.candidate._id === 'c-team'), 'team recruiter profile on assigned req is included');

console.log('sourceProfileSearch.service.test.js passed');
