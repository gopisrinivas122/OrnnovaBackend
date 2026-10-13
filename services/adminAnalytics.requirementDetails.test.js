const assert = require('assert');
const {
  computeRecruiterRequirementDetailsReport,
} = require('./adminAnalytics.service');

const SARAVAN_ID = '64aaaaaaaaaaaaaaaaaaa1';
const NAMRATA_ID = '64aaaaaaaaaaaaaaaaaaa2';
const ICF_REQ = '64bbbbbbbbbbbbbbbbbbb1';
const IBM_REQ = '64bbbbbbbbbbbbbbbbbbb2';
const ADA_REQ = '64bbbbbbbbbbbbbbbbbbb3';
const CLOSED_REQ = '64bbbbbbbbbbbbbbbbbbb4';

const users = [
  { _id: SARAVAN_ID, EmployeeName: 'Saravan', UserType: 'User', Requirements: [ICF_REQ, IBM_REQ, ADA_REQ] },
  { _id: NAMRATA_ID, EmployeeName: 'Namrata', UserType: 'User', Requirements: [ADA_REQ] },
];

function req({ id, client, role, type, members }) {
  return {
    _id: id,
    regId: id.slice(-4),
    client,
    role,
    requirementtype: type,
    numberOfPositions: 1,
    assignedMembers: members,
  };
}

const requirements = [
  req({
    id: ICF_REQ,
    client: 'ICF',
    role: 'Java Developer',
    type: 'High',
    members: [{ userId: SARAVAN_ID, assignedDate: '2026-09-10T10:00:00+05:30' }],
  }),
  req({
    id: IBM_REQ,
    client: 'IBM',
    role: 'Python Developer',
    type: 'High',
    members: [{ userId: SARAVAN_ID, assignedDate: '2026-09-12T10:00:00+05:30' }],
  }),
  req({
    id: ADA_REQ,
    client: 'ADA',
    role: 'Windchill Developer',
    type: 'Medium',
    members: [
      { userId: NAMRATA_ID, assignedDate: '2026-10-05T10:00:00+05:30' },
      { userId: SARAVAN_ID, assignedDate: '2026-10-05T10:00:00+05:30' },
    ],
  }),
  req({
    id: CLOSED_REQ,
    client: 'ClosedCo',
    role: 'Closed Role',
    type: 'Closed',
    members: [{ userId: SARAVAN_ID, assignedDate: '2026-09-08T10:00:00+05:30' }],
  }),
];

const candidateDocs = [
  {
    reqId: ICF_REQ,
    recruiterId: [SARAVAN_ID],
    candidates: [
      {
        _id: 'c-sep-1',
        firstName: 'Sep',
        lastName: 'One',
        savedStatus: 'Uploaded',
        uploadedOn: '2026-09-15T08:00:00+05:30',
        recruiterId: [SARAVAN_ID],
        Status: [{ Status: 'No Action Taken', Date: '2026-09-15T08:00:00+05:30' }],
      },
      {
        _id: 'c-oct-1',
        firstName: 'Oct',
        lastName: 'One',
        savedStatus: 'Uploaded',
        uploadedOn: '2026-10-08T08:00:00+05:30',
        recruiterId: [SARAVAN_ID],
        Status: [{ Status: 'No Action Taken', Date: '2026-10-08T08:00:00+05:30' }],
      },
    ],
  },
];

function employeeRow(report, userId) {
  return report.rows.find((row) => row.userId === userId);
}

const september = computeRecruiterRequirementDetailsReport(
  requirements,
  users,
  { fromDate: '2026-09-01', toDate: '2026-09-30' },
  candidateDocs,
);
const septSaravan = employeeRow(september, SARAVAN_ID);
assert.strictEqual(septSaravan.requirementCount, 3, 'September includes 2 active + closed-in-period history');
assert.ok(septSaravan.clients.includes('ICF') && septSaravan.clients.includes('IBM'));
assert.strictEqual(septSaravan.profilesSourcedCount, 1, 'September profiles only');
assert.strictEqual(septSaravan.uploadedProfiles[0].candidateId, 'c-sep-1');
assert.ok(!employeeRow(september, NAMRATA_ID) || employeeRow(september, NAMRATA_ID).requirementCount === 0);

const october = computeRecruiterRequirementDetailsReport(
  requirements,
  users,
  { fromDate: '2026-10-01', toDate: '2026-10-31' },
  candidateDocs,
);
const octSaravan = employeeRow(october, SARAVAN_ID);
assert.strictEqual(octSaravan.requirementCount, 3, 'October carries 2 active + ADA, excludes closed');
assert.deepStrictEqual(octSaravan.clients.slice().sort(), ['ADA', 'IBM', 'ICF']);
assert.strictEqual(octSaravan.profilesSourcedCount, 1, 'October profiles only, not cumulative');
assert.strictEqual(octSaravan.uploadedProfiles[0].candidateId, 'c-oct-1');
assert.strictEqual(
  new Date(octSaravan.requirements.find((item) => item.requirementId === ICF_REQ).assignedDate).toISOString().slice(0, 10),
  '2026-09-10',
);

const octNamrata = employeeRow(october, NAMRATA_ID);
assert.strictEqual(octNamrata.requirementCount, 1, 'Namrata only gets ADA, not Saravan September reqs');
assert.deepStrictEqual(octNamrata.clients, ['ADA']);

const LEGACY_REQ = '64bbbbbbbbbbbbbbbbbbb5';
const legacyUsers = [
  {
    _id: SARAVAN_ID,
    EmployeeName: 'Saravan',
    UserType: 'TeamLead',
    Requirements: [LEGACY_REQ],
  },
  { _id: NAMRATA_ID, EmployeeName: 'Namrata', UserType: 'User', Requirements: [] },
];
const legacyRequirements = [
  {
    _id: LEGACY_REQ,
    regId: '4785',
    client: 'IBM',
    role: 'TL Created Role',
    requirementtype: 'High',
    numberOfPositions: 1,
    uploadedDate: '2026-10-09T13:04:36.601Z',
    assignedMembers: [],
  },
];
const legacyOctober = computeRecruiterRequirementDetailsReport(
  legacyRequirements,
  legacyUsers,
  { fromDate: '2026-10-01', toDate: '2026-10-12' },
);
const legacySaravan = employeeRow(legacyOctober, SARAVAN_ID);
assert.strictEqual(legacySaravan.requirementCount, 1, 'Requirement List assignments without assignedMembers are counted');
assert.deepStrictEqual(legacySaravan.clients, ['IBM']);
assert.strictEqual(legacySaravan.requirements[0].assignedDate, null);
assert.ok(!employeeRow(legacyOctober, NAMRATA_ID) || employeeRow(legacyOctober, NAMRATA_ID).requirementCount === 0);

const legacySeptember = computeRecruiterRequirementDetailsReport(
  legacyRequirements,
  legacyUsers,
  { fromDate: '2026-09-01', toDate: '2026-09-30' },
);
assert.ok(
  !employeeRow(legacySeptember, SARAVAN_ID) || employeeRow(legacySeptember, SARAVAN_ID).requirementCount === 0,
  'Do not count current user.Requirements before the requirement existed',
);

console.log('adminAnalytics.requirementDetails.test.js passed');
