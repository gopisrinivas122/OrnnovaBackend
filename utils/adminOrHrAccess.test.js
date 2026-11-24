const assert = require('assert');
const { isAdminOrHrRole } = require('./constants');
const { canManageRequirementPriority } = require('./requirementPriority');
const { canUserEditRequirement } = require('../services/requirementWorkflow.service');

assert.strictEqual(isAdminOrHrRole('Admin'), true);
assert.strictEqual(isAdminOrHrRole('HR'), true);
assert.strictEqual(isAdminOrHrRole('TeamLead'), false);
assert.strictEqual(isAdminOrHrRole('User'), false);

assert.strictEqual(canManageRequirementPriority({ UserType: 'Admin' }), true);
assert.strictEqual(canManageRequirementPriority({ UserType: 'HR' }), true);
assert.strictEqual(canManageRequirementPriority({ UserType: 'TeamLead' }), false);
assert.strictEqual(canManageRequirementPriority({ UserType: 'User' }), false);

(async () => {
  const requirement = { _id: 'req-1', createdBy: 'tl-1', uploadedBy: 'tl-1' };

  assert.strictEqual(await canUserEditRequirement({ UserType: 'Admin', _id: 'admin-1' }, requirement), true);
  assert.strictEqual(await canUserEditRequirement({ UserType: 'HR', _id: 'hr-1' }, requirement), true);
  assert.strictEqual(
    await canUserEditRequirement({ UserType: 'TeamLead', _id: { toString: () => 'tl-1' } }, requirement),
    true
  );
  assert.strictEqual(
    await canUserEditRequirement({ UserType: 'TeamLead', _id: { toString: () => 'tl-2' } }, requirement),
    false
  );
  assert.strictEqual(await canUserEditRequirement({ UserType: 'User', _id: 'user-1' }, requirement), false);

  console.log('adminOrHrAccess tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
