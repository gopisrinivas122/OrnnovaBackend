const assert = require('assert');
const CandidateModel = require('../models/Candidate');
const NewUser = require('../models/User');
const NewRequirment = require('../models/Requirement');
const NewClient = require('../models/Client');
const { getAdminSourceProfiles } = require('./adminAnalytics.service');
const {
  searchDashboardSourceProfiles,
  listTeamLeadSourceProfiles,
  listRecruiterSourceProfiles,
} = require('./sourceProfileSearch.service');

const ADMIN_ID = '64aaaaaaaaaaaaaaaaaaa1';
const HR_ID = '64aaaaaaaaaaaaaaaaaaa2';
const TL_OWN_ID = '64aaaaaaaaaaaaaaaaaaa3';
const TL_FULL_ID = '64aaaaaaaaaaaaaaaaaaa4';
const RECRUITER_ID = '64aaaaaaaaaaaaaaaaaaa5';
const CLIENT_ID = '64ccccccccccccccccccc1';
const REQ_CLIENT = '64bbbbbbbbbbbbbbbbbbb1';
const REQ_ASSIGNED = '64bbbbbbbbbbbbbbbbbbb2';

function queryResult(docs) {
  const query = Promise.resolve(docs);
  query.select = () => query;
  query.lean = () => Promise.resolve(docs);
  query.exec = () => Promise.resolve(docs);
  return query;
}

function localDateInput(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function noonInside(dateInput) {
  const from = new Date(dateInput);
  from.setHours(0, 0, 0, 0);
  const to = new Date(dateInput);
  to.setHours(23, 59, 59, 999);
  return new Date((from.getTime() + to.getTime()) / 2);
}

const today = localDateInput(0);
const yesterday = localDateInput(-1);

const users = [
  { _id: ADMIN_ID, EmployeeName: 'Asha Admin', UserType: 'Admin', Requirements: [], Clients: [] },
  { _id: HR_ID, EmployeeName: 'Hari HR', UserType: 'HR', Requirements: [], Clients: [] },
  {
    _id: TL_OWN_ID,
    EmployeeName: 'Tara Lead',
    UserType: 'TeamLead',
    Requirements: [REQ_ASSIGNED],
    excludedRequirements: [],
    Clients: [],
  },
  {
    _id: TL_FULL_ID,
    EmployeeName: 'Full Lead',
    UserType: 'TeamLead',
    Requirements: [],
    excludedRequirements: [],
    Clients: [CLIENT_ID],
  },
  {
    _id: RECRUITER_ID,
    EmployeeName: 'Ravi Recruiter',
    UserType: 'User',
    Requirements: [REQ_ASSIGNED],
    Clients: [],
  },
];

const requirements = [
  {
    _id: REQ_CLIENT,
    regId: '9001',
    client: 'Acme',
    clientId: CLIENT_ID,
    role: 'Developer',
    createdBy: ADMIN_ID,
    uploadedBy: ADMIN_ID,
  },
  {
    _id: REQ_ASSIGNED,
    regId: '9002',
    client: 'Other Co',
    clientId: '64ccccccccccccccccccc2',
    role: 'Analyst',
    createdBy: ADMIN_ID,
    uploadedBy: ADMIN_ID,
  },
];

function profile({ id, reqId, ownerId, ownerName, firstName, uploadedOn }) {
  return {
    reqId,
    recruiterId: [ownerId],
    candidates: [
      {
        _id: id,
        firstName,
        lastName: 'Profile',
        savedStatus: 'Uploaded',
        uploadedOn,
        recruiterId: [ownerId],
        recruiterName: ownerName,
        Status: [{ Status: 'No Action Taken', Date: uploadedOn }],
      },
    ],
  };
}

const candidateDocs = [
  profile({
    id: 'c-admin-today',
    reqId: REQ_CLIENT,
    ownerId: ADMIN_ID,
    ownerName: 'Asha Admin',
    firstName: 'Ada',
    uploadedOn: noonInside(today),
  }),
  profile({
    id: 'c-hr-yesterday',
    reqId: REQ_CLIENT,
    ownerId: HR_ID,
    ownerName: 'Hari HR',
    firstName: 'Hari',
    uploadedOn: noonInside(yesterday),
  }),
  profile({
    id: 'c-tl-today',
    reqId: REQ_ASSIGNED,
    ownerId: TL_OWN_ID,
    ownerName: 'Tara Lead',
    firstName: 'Tara',
    uploadedOn: noonInside(today),
  }),
  profile({
    id: 'c-recruiter-yesterday',
    reqId: REQ_ASSIGNED,
    ownerId: RECRUITER_ID,
    ownerName: 'Ravi Recruiter',
    firstName: 'Ravi',
    uploadedOn: noonInside(yesterday),
  }),
  profile({
    id: 'c-admin-old',
    reqId: REQ_CLIENT,
    ownerId: ADMIN_ID,
    ownerName: 'Asha Admin',
    firstName: 'Nila',
    uploadedOn: noonInside('2026-05-15'),
  }),
  profile({
    id: 'c-admin-assigned',
    reqId: REQ_ASSIGNED,
    ownerId: ADMIN_ID,
    ownerName: 'Asha Admin',
    firstName: 'Secret',
    uploadedOn: noonInside(today),
  }),
];

const userQueries = [];

function installStubs() {
  NewUser.find = (query = {}) => {
    userQueries.push(query);
    const types = query.UserType && query.UserType.$in;
    const matched = types
      ? users.filter((user) => types.includes(user.UserType))
      : users;
    return queryResult(matched);
  };
  NewUser.findById = (id) => queryResult(users.find((user) => user._id === String(id)) || null);
  NewRequirment.find = (query = {}) => {
    const idClause = (query.$or || []).find((clause) => clause._id && clause._id.$in);
    if (!idClause) return queryResult(requirements);
    const ids = new Set(idClause._id.$in.map(String));
    return queryResult(requirements.filter((requirement) => ids.has(String(requirement._id))));
  };
  CandidateModel.find = () => queryResult(candidateDocs);
  NewClient.find = () => queryResult([{ _id: CLIENT_ID, ClientName: 'Acme' }]);
}

function candidateNames(result) {
  return result.recruiters
    .flatMap((group) => group.candidates.map((candidate) => candidate.firstName))
    .sort();
}

function uploaderLabels(result) {
  return result.recruiters
    .map((group) => `${group.recruiter.EmployeeName}|${group.recruiter.UserType}`)
    .sort();
}

async function run() {
  installStubs();

  const todayProfiles = await getAdminSourceProfiles({ fromDate: today, toDate: today });
  assert.deepStrictEqual(candidateNames(todayProfiles), ['Ada', 'Secret', 'Tara']);
  assert.ok(uploaderLabels(todayProfiles).includes('Asha Admin|Admin'));
  assert.ok(uploaderLabels(todayProfiles).includes('Tara Lead|TeamLead'));

  const yesterdayProfiles = await getAdminSourceProfiles({ fromDate: yesterday, toDate: yesterday });
  assert.deepStrictEqual(candidateNames(yesterdayProfiles), ['Hari', 'Ravi']);
  assert.ok(uploaderLabels(yesterdayProfiles).includes('Hari HR|HR'));
  assert.ok(uploaderLabels(yesterdayProfiles).includes('Ravi Recruiter|User'));

  const customProfiles = await getAdminSourceProfiles({ fromDate: yesterday, toDate: today });
  assert.deepStrictEqual(
    candidateNames(customProfiles),
    ['Ada', 'Hari', 'Ravi', 'Secret', 'Tara'],
  );
  assert.deepStrictEqual(uploaderLabels(customProfiles), [
    'Asha Admin|Admin',
    'Hari HR|HR',
    'Ravi Recruiter|User',
    'Tara Lead|TeamLead',
  ]);

  const allProfiles = await getAdminSourceProfiles();
  assert.strictEqual(allProfiles.period.fromDate, null);
  assert.strictEqual(allProfiles.period.toDate, null);
  assert.ok(candidateNames(allProfiles).includes('Nila'));
  assert.strictEqual(allProfiles.total, 6);

  const adminSearch = await searchDashboardSourceProfiles({
    actorId: ADMIN_ID,
    actorRole: 'Admin',
    name: 'Nila',
  });
  assert.deepStrictEqual(candidateNames(adminSearch), ['Nila']);
  assert.deepStrictEqual(uploaderLabels(adminSearch), ['Asha Admin|Admin']);
  assert.strictEqual(adminSearch.period.fromDate, null);

  const hrSearch = await searchDashboardSourceProfiles({
    actorId: HR_ID,
    actorRole: 'HR',
    name: 'Hari',
  });
  assert.deepStrictEqual(candidateNames(hrSearch), ['Hari']);
  assert.deepStrictEqual(uploaderLabels(hrSearch), ['Hari HR|HR']);

  const recruiterOwn = await listRecruiterSourceProfiles({
    actorId: RECRUITER_ID,
    name: 'Ravi',
  });
  assert.deepStrictEqual(candidateNames(recruiterOwn), ['Ravi']);

  const recruiterBlocked = await searchDashboardSourceProfiles({
    actorId: RECRUITER_ID,
    actorRole: 'User',
    name: 'Secret',
  });
  assert.deepStrictEqual(candidateNames(recruiterBlocked), []);

  const teamLeadOwn = await listTeamLeadSourceProfiles({
    actorId: TL_OWN_ID,
    name: 'Secret',
  });
  assert.deepStrictEqual(candidateNames(teamLeadOwn), []);

  const teamLeadOwnVisible = await listTeamLeadSourceProfiles({
    actorId: TL_OWN_ID,
    fromDate: today,
    toDate: today,
  });
  assert.deepStrictEqual(candidateNames(teamLeadOwnVisible), ['Tara']);

  const teamLeadFull = await listTeamLeadSourceProfiles({
    actorId: TL_FULL_ID,
    name: 'Nila',
  });
  assert.deepStrictEqual(candidateNames(teamLeadFull), ['Nila']);
  assert.deepStrictEqual(uploaderLabels(teamLeadFull), ['Asha Admin|Admin']);

  const teamLeadFullYesterday = await listTeamLeadSourceProfiles({
    actorId: TL_FULL_ID,
    fromDate: yesterday,
    toDate: yesterday,
  });
  assert.deepStrictEqual(candidateNames(teamLeadFullYesterday), ['Hari']);
  assert.ok(!candidateNames(teamLeadFullYesterday).includes('Ravi'));

  userQueries.forEach((query) => {
    const types = query.UserType && query.UserType.$in;
    assert.ok(Array.isArray(types), 'profile lookups filter users by role');
    assert.ok(types.includes('Admin'));
    assert.ok(types.includes('HR'));
    assert.ok(types.includes('TeamLead'));
    assert.ok(types.includes('User'));
  });

  console.log('sourceProfileUploaderRoles.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
