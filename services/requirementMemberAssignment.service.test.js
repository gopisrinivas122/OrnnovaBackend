const assert = require('assert');
const {
  userHasRequirement,
  addRequirementToUserIfMissing,
  appendAssignedMemberIfMissing,
} = require('./requirementMemberAssignment.service');

const originalDate = new Date('2026-10-01T00:00:00.000Z');
const laterDate = new Date('2026-10-12T00:00:00.000Z');

const user = {
  _id: '507f1f77bcf86cd799439011',
  UserType: 'User',
  EmployeeName: 'Supriya',
  Email: 'supriya@example.com',
  Requirements: [],
};

const requirement = {
  _id: '507f191e810c19729de860ea',
  assignedMembers: [
    {
      userId: '507f1f77bcf86cd799439099',
      userType: 'User',
      employeeName: 'Existing Recruiter',
      email: 'existing@example.com',
      assignedDate: originalDate,
    },
  ],
};

assert.strictEqual(userHasRequirement(user, requirement._id), false);
assert.strictEqual(addRequirementToUserIfMissing(user, requirement._id), true);
assert.strictEqual(userHasRequirement(user, requirement._id), true);
assert.strictEqual(addRequirementToUserIfMissing(user, requirement._id), false);
assert.strictEqual(user.Requirements.length, 1);

const firstAssign = appendAssignedMemberIfMissing(requirement, user, originalDate);
assert.strictEqual(firstAssign.added, true);
assert.strictEqual(requirement.assignedMembers.length, 2);
assert.strictEqual(String(requirement.assignedMembers[1].userId), String(user._id));
assert.strictEqual(requirement.assignedMembers[0].employeeName, 'Existing Recruiter');

const secondAssign = appendAssignedMemberIfMissing(requirement, user, laterDate);
assert.strictEqual(secondAssign.added, false);
assert.strictEqual(requirement.assignedMembers.length, 2);
assert.strictEqual(
  new Date(requirement.assignedMembers[1].assignedDate).toISOString(),
  originalDate.toISOString(),
);

console.log('requirementMemberAssignment.service.test.js passed');
