const assert = require('assert');
const {
  countReqsAssignedForEmployee,
  listReqsAssignedForEmployee,
  profileSourcedByEmployeeInRange,
} = require('./employeeWorkSummary.service');

const SARAVAN_ID = '64aaaaaaaaaaaaaaaaaaa1';
const NAMRATA_ID = '64aaaaaaaaaaaaaaaaaaa2';
const ICF_REQ = '64bbbbbbbbbbbbbbbbbbb1';
const IBM_REQ = '64bbbbbbbbbbbbbbbbbbb2';
const ADA_REQ = '64bbbbbbbbbbbbbbbbbbb3';
const CLOSED_REQ = '64bbbbbbbbbbbbbbbbbbb4';

const requirements = [
  {
    _id: ICF_REQ,
    regId: '1001',
    client: 'ICF',
    role: 'Java Developer',
    requirementtype: 'High',
    assignedMembers: [
      { userId: SARAVAN_ID, assignedDate: '2026-09-10T10:00:00+05:30' },
      { userId: SARAVAN_ID, assignedDate: '2026-09-10T10:00:00+05:30' },
    ],
  },
  {
    _id: IBM_REQ,
    regId: '1002',
    client: 'IBM',
    role: 'Python Developer',
    requirementtype: 'High',
    assignedMembers: [{ userId: SARAVAN_ID, assignedDate: '2026-09-12T10:00:00+05:30' }],
  },
  {
    _id: ADA_REQ,
    regId: '1003',
    client: 'ADA',
    role: 'Windchill Developer',
    requirementtype: 'Medium',
    assignedMembers: [{ userId: SARAVAN_ID, assignedDate: '2026-10-05T10:00:00+05:30' }],
  },
  {
    _id: CLOSED_REQ,
    regId: '1004',
    client: 'ClosedCo',
    role: 'Closed Role',
    requirementtype: 'Closed',
    assignedMembers: [{ userId: SARAVAN_ID, assignedDate: '2026-09-08T10:00:00+05:30' }],
  },
];

assert.strictEqual(
  countReqsAssignedForEmployee(requirements, SARAVAN_ID, '2026-09-01', '2026-09-30'),
  3,
  'September includes 2 active + closed assigned in September, no duplicate ICF',
);
assert.strictEqual(
  countReqsAssignedForEmployee(requirements, SARAVAN_ID, '2026-10-01', '2026-10-31'),
  3,
  'October carries 2 active + ADA and excludes closed',
);
assert.strictEqual(
  countReqsAssignedForEmployee(requirements, NAMRATA_ID, '2026-10-01', '2026-10-31'),
  0,
  'Namrata is not assigned to Saravan requirements',
);

const octoberRows = listReqsAssignedForEmployee(requirements, SARAVAN_ID, '2026-10-01', '2026-10-31');
const icf = octoberRows.find((row) => row.requirementId === ICF_REQ);
assert.ok(icf);
assert.strictEqual(new Date(icf.assignedDate).toISOString().slice(0, 10), '2026-09-10');

const sepProfile = {
  recruiterIds: [SARAVAN_ID],
  candidate: {
    _id: 'c-sep',
    uploadedOn: '2026-09-15T08:00:00+05:30',
    recruiterId: [SARAVAN_ID],
  },
};
const octProfile = {
  recruiterIds: [SARAVAN_ID],
  candidate: {
    _id: 'c-oct',
    uploadedOn: '2026-10-08T08:00:00+05:30',
    recruiterId: [SARAVAN_ID],
  },
};

assert.strictEqual(profileSourcedByEmployeeInRange(sepProfile, SARAVAN_ID, '2026-09-01', '2026-09-30'), true);
assert.strictEqual(profileSourcedByEmployeeInRange(octProfile, SARAVAN_ID, '2026-09-01', '2026-09-30'), false);
assert.strictEqual(profileSourcedByEmployeeInRange(sepProfile, SARAVAN_ID, '2026-10-01', '2026-10-31'), false);
assert.strictEqual(profileSourcedByEmployeeInRange(octProfile, SARAVAN_ID, '2026-10-01', '2026-10-31'), true);

const LEGACY_REQ = '64bbbbbbbbbbbbbbbbbbb5';
const legacyRequirements = [
  {
    _id: LEGACY_REQ,
    regId: '4785',
    client: 'IBM',
    role: 'Legacy Role',
    requirementtype: 'High',
    uploadedDate: '2026-10-09T13:04:36.601Z',
    assignedMembers: [],
  },
];
const saravanUser = { _id: SARAVAN_ID, Requirements: [LEGACY_REQ] };
const namrataUser = { _id: NAMRATA_ID, Requirements: [] };

assert.strictEqual(
  countReqsAssignedForEmployee(legacyRequirements, SARAVAN_ID, '2026-10-01', '2026-10-12', saravanUser),
  1,
  'Current user.Requirements without assignedMembers count in the selected month',
);
assert.strictEqual(
  listReqsAssignedForEmployee(legacyRequirements, SARAVAN_ID, '2026-10-01', '2026-10-12', saravanUser)[0].assignedDate,
  null,
  'Do not invent an assignedDate for user.Requirements fallback',
);
assert.strictEqual(
  countReqsAssignedForEmployee(legacyRequirements, SARAVAN_ID, '2026-09-01', '2026-09-30', saravanUser),
  0,
  'Requirements uploaded after the period are excluded',
);
assert.strictEqual(
  countReqsAssignedForEmployee(legacyRequirements, NAMRATA_ID, '2026-10-01', '2026-10-12', namrataUser),
  0,
  'Namrata is not currently assigned via user.Requirements',
);

const datedAndLegacy = [
  ...requirements,
  {
    _id: LEGACY_REQ,
    regId: '4785',
    client: 'IBM',
    role: 'Legacy Role',
    requirementtype: 'High',
    uploadedDate: '2026-10-09T13:04:36.601Z',
    assignedMembers: [],
  },
];
assert.strictEqual(
  countReqsAssignedForEmployee(
    datedAndLegacy,
    SARAVAN_ID,
    '2026-10-01',
    '2026-10-12',
    { _id: SARAVAN_ID, Requirements: [ICF_REQ, IBM_REQ, ADA_REQ, CLOSED_REQ, LEGACY_REQ] },
  ),
  4,
  'Dated assignedMembers plus current user.Requirements, still excluding closed carry-forward',
);

console.log('employeeWorkSummary.service.test.js passed');
