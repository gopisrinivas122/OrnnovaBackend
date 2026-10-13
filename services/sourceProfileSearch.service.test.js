const assert = require('assert');
const {
  buildVisibleRequirementIdSet,
  rowMatchesVisibleRequirement,
  rowOwnedByAllowedRecruiters,
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

console.log('sourceProfileSearch.service.test.js passed');
