const assert = require('assert');
const {
  getManualProfileUploadEnabled,
  computeUploadDisplayState,
  applyUserUploadSettingsToUpdate,
  resolveUserUploadSettingsFromRequest,
} = require('./requirementUploadSettings.util');
const { getPositionLimit } = require('../services/requirementPositionLimit.service');

const existingSettings = [
  {
    userId: 'rec-1',
    profileUploadEnabled: false,
    manuallyStopped: true,
  },
  {
    userId: 'rec-2',
    profileUploadEnabled: true,
    manuallyStopped: false,
  },
];

const positionsOnlyBody = {
  numberOfPositions: '3',
  role: 'Java Developer',
};
const positionsOnlyUpdate = { ...positionsOnlyBody, userUploadSettings: String(existingSettings) };
const appliedOmit = applyUserUploadSettingsToUpdate(positionsOnlyUpdate, positionsOnlyBody);
assert.ok(appliedOmit.ok);
assert.ok(!Object.prototype.hasOwnProperty.call(positionsOnlyUpdate, 'userUploadSettings'));
assert.strictEqual(positionsOnlyUpdate.numberOfPositions, '3');

const withValidSettings = { numberOfPositions: 4 };
const validApply = applyUserUploadSettingsToUpdate(withValidSettings, {
  numberOfPositions: 4,
  userUploadSettings: existingSettings,
});
assert.ok(validApply.ok);
assert.ok(Array.isArray(withValidSettings.userUploadSettings));
assert.strictEqual(typeof withValidSettings.userUploadSettings, 'object');
assert.notStrictEqual(withValidSettings.userUploadSettings, String(existingSettings));
assert.deepStrictEqual(
  withValidSettings.userUploadSettings.map((item) => item.userId),
  ['rec-1', 'rec-2'],
);

const jsonStringApplyTarget = { numberOfPositions: 2 };
const jsonStringApply = applyUserUploadSettingsToUpdate(jsonStringApplyTarget, {
  userUploadSettings: JSON.stringify(existingSettings),
});
assert.ok(jsonStringApply.ok);
assert.ok(Array.isArray(jsonStringApplyTarget.userUploadSettings));
assert.ok(!jsonStringApplyTarget.userUploadSettings.some((item) => typeof item === 'string'));

const malformedUpdate = { numberOfPositions: 5, userUploadSettings: '[object Object],[object Object],[object Object]' };
const malformed = applyUserUploadSettingsToUpdate(malformedUpdate, {
  numberOfPositions: 5,
  userUploadSettings: '[object Object],[object Object],[object Object]',
});
assert.strictEqual(malformed.ok, false);
assert.match(malformed.message, /array of objects/i);
assert.ok(!Object.prototype.hasOwnProperty.call(malformedUpdate, 'userUploadSettings'));

const invalidJson = applyUserUploadSettingsToUpdate({}, { userUploadSettings: '{not-json' });
assert.strictEqual(invalidJson.ok, false);

assert.strictEqual(
  resolveUserUploadSettingsFromRequest(undefined).action,
  'omit',
);

const requirement = { userUploadSettings: existingSettings, numberOfPositions: 2 };
assert.strictEqual(getManualProfileUploadEnabled(requirement, 'rec-1'), false);
assert.strictEqual(getManualProfileUploadEnabled(requirement, 'rec-2'), true);
assert.strictEqual(computeUploadDisplayState(requirement, 'rec-1', true).uploadAction, 'start');
assert.strictEqual(computeUploadDisplayState(requirement, 'rec-2', true).uploadAction, 'stop');

const afterPositionsEdit = { ...requirement, numberOfPositions: 5 };
assert.strictEqual(getManualProfileUploadEnabled(afterPositionsEdit, 'rec-1'), false);
assert.strictEqual(getManualProfileUploadEnabled(afterPositionsEdit, 'rec-2'), true);
assert.strictEqual(getPositionLimit({ numberOfPositions: 5 }), 5);
assert.strictEqual(getPositionLimit({ numberOfPositions: 1 }), 1);
assert.ok(3 >= getPositionLimit({ numberOfPositions: 2 }), 'joined count still compared to positions');
assert.ok(!(1 >= getPositionLimit({ numberOfPositions: 2 })));

const otherFieldsUpdate = { skill: 'React', location: 'Hyderabad' };
const otherFields = applyUserUploadSettingsToUpdate(otherFieldsUpdate, { skill: 'React', location: 'Hyderabad' });
assert.ok(otherFields.ok);
assert.deepStrictEqual(otherFieldsUpdate, { skill: 'React', location: 'Hyderabad' });

console.log('requirementUploadSettings.util.test.js passed');
