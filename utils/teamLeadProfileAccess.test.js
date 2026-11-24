const assert = require('assert');
const {
  classifyTeamLeadRequirement,
  buildTeamLeadProfileAccess,
  candidateRowVisibleToTeamLead,
} = require('./teamLeadProfileAccess');

const clientOwner = {
  _id: 'tl-owner',
  UserType: 'TeamLead',
  Clients: ['client-ada'],
  Requirements: ['req-ada-assigned', 'req-owned-extra'],
  excludedRequirements: ['req-ada-excluded'],
};

const assignedLead = {
  _id: 'tl-assigned',
  UserType: 'TeamLead',
  Clients: ['client-icf'],
  Requirements: ['req-ada-assigned', 'req-icf'],
  excludedRequirements: [],
};

const requirements = [
  { _id: 'req-ada-assigned', clientId: 'client-ada', client: 'ADA', regId: 'ADA-1' },
  { _id: 'req-ada-other', clientId: 'client-ada', client: 'ADA', regId: 'ADA-2' },
  { _id: 'req-ada-excluded', clientId: 'client-ada', client: 'ADA', regId: 'ADA-X' },
  { _id: 'req-icf', clientId: 'client-icf', client: 'ICF', regId: 'ICF-1' },
];

assert.strictEqual(classifyTeamLeadRequirement(clientOwner, requirements[0]), 'full');
assert.strictEqual(classifyTeamLeadRequirement(clientOwner, requirements[1]), 'full');
assert.strictEqual(classifyTeamLeadRequirement(clientOwner, requirements[2]), 'none');
assert.strictEqual(classifyTeamLeadRequirement(clientOwner, requirements[3]), 'none');

assert.strictEqual(classifyTeamLeadRequirement(assignedLead, requirements[0]), 'own');
assert.strictEqual(classifyTeamLeadRequirement(assignedLead, requirements[1]), 'none');
assert.strictEqual(classifyTeamLeadRequirement(assignedLead, requirements[3]), 'full');

const ownerAccess = buildTeamLeadProfileAccess(clientOwner, requirements);
const assignedAccess = buildTeamLeadProfileAccess(assignedLead, requirements);

const ownerProfile = {
  reqId: 'req-ada-assigned',
  recruiterIds: ['tl-owner'],
  candidate: { recruiterId: ['tl-owner'] },
};
const assignedOwnProfile = {
  reqId: 'req-ada-assigned',
  recruiterIds: ['tl-assigned'],
  candidate: { recruiterId: ['tl-assigned'] },
};
const recruiterProfile = {
  reqId: 'req-ada-assigned',
  recruiterIds: ['recruiter-1'],
  candidate: { recruiterId: ['recruiter-1'] },
};
const otherRequirementProfile = {
  reqId: 'req-ada-other',
  recruiterIds: ['tl-assigned'],
  candidate: { recruiterId: ['tl-assigned'] },
};
const icfRecruiterProfile = {
  reqId: 'req-icf',
  recruiterIds: ['recruiter-2'],
  candidate: { recruiterId: ['recruiter-2'] },
};

assert.strictEqual(candidateRowVisibleToTeamLead(ownerProfile, ownerAccess), true);
assert.strictEqual(candidateRowVisibleToTeamLead(recruiterProfile, ownerAccess), true);
assert.strictEqual(candidateRowVisibleToTeamLead(assignedOwnProfile, ownerAccess), true);
assert.strictEqual(candidateRowVisibleToTeamLead(otherRequirementProfile, ownerAccess), true);

assert.strictEqual(candidateRowVisibleToTeamLead(assignedOwnProfile, assignedAccess), true);
assert.strictEqual(candidateRowVisibleToTeamLead(ownerProfile, assignedAccess), false);
assert.strictEqual(candidateRowVisibleToTeamLead(recruiterProfile, assignedAccess), false);
assert.strictEqual(candidateRowVisibleToTeamLead(otherRequirementProfile, assignedAccess), false);
assert.strictEqual(candidateRowVisibleToTeamLead(icfRecruiterProfile, assignedAccess), true);

assert.strictEqual(ownerAccess.fullKeys.has('ADA-1'), true);
assert.strictEqual(assignedAccess.ownKeys.has('ADA-1'), true);
assert.strictEqual(assignedAccess.fullKeys.has('ICF-1'), true);
assert.strictEqual(assignedAccess.fullKeys.has('ADA-2'), false);

console.log('teamLeadProfileAccess tests passed');
