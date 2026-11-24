const assert = require('assert');
const CandidateModel = require('../models/Candidate');
const NewUser = require('../models/User');
const NewRequirment = require('../models/Requirement');
const {
  canUserUploadToRequirement,
  canUserClaimRequirement,
  enrichRequirementWorkflow,
  validateUploadAllowed,
} = require('./requirementWorkflow.service');
const { canUserAccessCandidateDocuments } = require('./candidateDocumentUpdate.service');

let candidateDocs = [];

function queryResult(docs) {
  const query = Promise.resolve(docs);
  query.select = () => query;
  query.lean = () => Promise.resolve(docs);
  query.exec = () => Promise.resolve(docs);
  return query;
}

CandidateModel.find = () => queryResult(candidateDocs);

function actor(id, userType, status = 'Active') {
  return {
    _id: { toString: () => id },
    UserType: userType,
    Status: status,
    Requirements: [],
  };
}

function requirement(overrides = {}) {
  return {
    _id: 'req-1',
    requirementtype: 'High',
    numberOfPositions: 2,
    claimedBy: [],
    assignedMembers: [],
    userUploadSettings: [],
    ...overrides,
  };
}

function joinedDocs() {
  return [{
    reqId: 'req-1',
    candidates: [{ Status: [{ Status: 'Joined' }] }, { Status: [{ Status: 'Joined' }] }],
  }];
}

(async () => {
  const openRequirement = requirement();
  const admin = actor('admin-1', 'Admin');
  const hr = actor('hr-1', 'HR');
  const recruiter = actor('rec-1', 'User');
  const teamLead = actor('tl-1', 'TeamLead');

  assert.strictEqual(await canUserClaimRequirement(admin, openRequirement), false);
  assert.strictEqual(await canUserClaimRequirement(hr, openRequirement), false);
  assert.strictEqual(await canUserUploadToRequirement(admin, openRequirement), true);
  assert.strictEqual(await canUserUploadToRequirement(hr, openRequirement), true);
  assert.deepStrictEqual(openRequirement.claimedBy, []);

  assert.strictEqual(
    await canUserUploadToRequirement(actor('admin-2', 'Admin', 'InActive'), openRequirement),
    false
  );
  assert.strictEqual(
    await canUserUploadToRequirement(admin, requirement({ requirementtype: 'Closed' })),
    false
  );
  assert.strictEqual(
    await canUserUploadToRequirement(hr, requirement({ requirementtype: 'On-Hold-Internal' })),
    false
  );

  candidateDocs = joinedDocs();
  const filled = requirement({ numberOfPositions: 2 });
  assert.strictEqual(await canUserUploadToRequirement(admin, filled), false);
  assert.strictEqual(await canUserUploadToRequirement(hr, filled), false);
  candidateDocs = [];

  assert.strictEqual(await canUserClaimRequirement(recruiter, openRequirement), false);
  assert.strictEqual(await canUserUploadToRequirement(recruiter, openRequirement), false);
  const assignedOnly = requirement();
  recruiter.Requirements = ['req-1'];
  assert.strictEqual(await canUserClaimRequirement(recruiter, assignedOnly), true);
  assert.strictEqual(await canUserUploadToRequirement(recruiter, assignedOnly), false);

  const claimed = requirement({
    claimedBy: [{ userId: 'rec-1', claimedDate: new Date() }],
  });
  assert.strictEqual(await canUserUploadToRequirement(recruiter, claimed), true);

  const stopped = requirement({
    claimedBy: [{ userId: 'rec-1', claimedDate: new Date() }],
    userUploadSettings: [{ userId: 'rec-1', manuallyStopped: true }],
  });
  assert.strictEqual(await canUserUploadToRequirement(recruiter, stopped), false);

  candidateDocs = joinedDocs();
  assert.strictEqual(await canUserUploadToRequirement(recruiter, requirement({
    numberOfPositions: 1,
    claimedBy: [{ userId: 'rec-1', claimedDate: new Date() }],
  })), false);
  candidateDocs = [];

  assert.strictEqual(await canUserUploadToRequirement(teamLead, openRequirement), false);
  const claimedByLead = requirement({
    createdBy: 'tl-1',
    claimedBy: [{ userId: 'tl-1', claimedDate: new Date() }],
  });
  assert.strictEqual(await canUserUploadToRequirement(teamLead, claimedByLead), true);
  assert.strictEqual(await canUserClaimRequirement(teamLead, requirement({ createdBy: 'tl-1' })), true);

  const closedButClaimed = requirement({
    requirementtype: 'Closed',
    claimedBy: [{ userId: 'rec-1', claimedDate: new Date() }],
  });
  assert.strictEqual(await canUserUploadToRequirement(recruiter, closedButClaimed), true);

  const adminWorkflow = await enrichRequirementWorkflow(requirement(), admin);
  assert.strictEqual(adminWorkflow.workflow.canUpload, true);
  assert.strictEqual(adminWorkflow.workflow.canClaim, false);
  assert.notStrictEqual(adminWorkflow.workflow.workflowBadge, 'Claimed');

  const recruiterWorkflow = await enrichRequirementWorkflow(claimed, recruiter);
  assert.strictEqual(recruiterWorkflow.workflow.canUpload, true);
  assert.strictEqual(recruiterWorkflow.workflow.workflowBadge, 'Claimed');

  const users = {
    'admin-1': admin,
    'hr-1': hr,
    'rec-1': recruiter,
  };
  const requirements = {
    'req-open': requirement(),
    'req-closed': requirement({ requirementtype: 'Closed' }),
    'req-filled': requirement({ numberOfPositions: 1 }),
    'req-unclaimed': requirement(),
  };
  NewUser.findById = (id) => queryResult(users[String(id)] || null);
  NewRequirment.findById = (id) => queryResult(requirements[String(id)] || null);

  const adminUpload = await validateUploadAllowed('req-open', { user: { id: 'admin-1', role: 'Admin' } }, 'admin-1');
  assert.strictEqual(adminUpload.allowed, true);
  assert.deepStrictEqual(requirements['req-open'].claimedBy, []);

  const hrUpload = await validateUploadAllowed('req-open', { user: { id: 'hr-1', role: 'HR' } }, 'hr-1');
  assert.strictEqual(hrUpload.allowed, true);

  const closedUpload = await validateUploadAllowed('req-closed', { user: { id: 'admin-1', role: 'Admin' } }, 'admin-1');
  assert.strictEqual(closedUpload.allowed, false);
  assert.match(closedUpload.message, /stopped or closed/i);

  candidateDocs = [{
    reqId: 'req-1',
    candidates: [{ Status: [{ Status: 'Joined' }] }],
  }];
  const filledUpload = await validateUploadAllowed('req-filled', { user: { id: 'hr-1', role: 'HR' } }, 'hr-1');
  assert.strictEqual(filledUpload.allowed, false);
  assert.match(filledUpload.message, /positions has been filled/i);
  candidateDocs = [];

  const recruiterBlocked = await validateUploadAllowed('req-unclaimed', { user: { id: 'rec-1', role: 'User' } }, 'rec-1');
  assert.strictEqual(recruiterBlocked.allowed, false);
  assert.match(recruiterBlocked.message, /claim this requirement/i);

  const context = { candidate: { _id: 'cand-1', recruiterId: ['rec-1'] }, docRecruiterIds: ['rec-1'] };
  assert.strictEqual(await canUserAccessCandidateDocuments('admin-1', 'Admin', context), true);
  assert.strictEqual(await canUserAccessCandidateDocuments('hr-1', 'HR', context), true);
  assert.strictEqual(await canUserAccessCandidateDocuments('', 'HR', context), false);

  NewUser.findById = () => queryResult({ _id: 'user-2', UserType: 'User' });
  assert.strictEqual(await canUserAccessCandidateDocuments('user-2', 'User', context), false);

  console.log('admin/hr upload permission tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
