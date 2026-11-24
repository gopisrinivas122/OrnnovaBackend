const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

process.env.OFFER_WORKFLOW_ENABLED = 'true';

const { EXISTING_USER_TYPES, USER_TYPES } = require('../utils/constants');
const { ALLOWED_USER_TYPES } = require('./userImport.service');
const { authorizeRoles } = require('../middleware/auth');
const { calculateCommercials } = require('./offerFinance.service');
const { canReadOffer, canEditDraft, canEditOfferDetails, buildOfferListFilter } = require('./offerAccess.service');
const { resolvePrivateDocumentPath } = require('../config/offerDocumentUpload');
const {
  buildOfferSourceEventId,
  createOfferWorkflowNotification,
} = require('./offerNotification.service');
const {
  REQUIRED_DOCUMENT_TYPES,
  EXPERIENCED_DOCUMENT_TYPES,
} = require('../utils/offerWorkflow.constants');
const {
  OfferWorkflowError,
  resolveTeamLeadSelection,
  buildCandidateSnapshot,
  assessOfferGenerationReadiness,
  validateOfferForSubmission,
  resolveTransition,
  applyDraftPatch,
} = require('./offerWorkflow.rules');
const { createOfferWorkflowService, formatOfferRequestNumber } = require('./offerWorkflow.service');
const registerOfferRoutes = require('../routes/offer.routes');

function completeRequiredDocuments(employmentCategory = 'Experienced') {
  const types = [...REQUIRED_DOCUMENT_TYPES];
  if (employmentCategory === 'Experienced') types.push(...EXPERIENCED_DOCUMENT_TYPES);
  return types.map((documentType, index) => ({
    _id: `doc-${index + 1}`,
    documentType,
    originalFilename: `${documentType}.pdf`,
    storageKey: `offer-${documentType}.pdf`,
    verificationStatus: 'Verified',
  }));
}

const ADMIN = 'a'.repeat(24);
const TL = 'b'.repeat(24);
const TL_TWO = 'c'.repeat(24);
const HR = 'd'.repeat(24);
const MD = 'e'.repeat(24);
const RECRUITER = 'f'.repeat(24);
const USER = '1'.repeat(24);
const OUTER = '2'.repeat(24);
const SUB = '3'.repeat(24);

function actor(id, role) {
  return { id, role, name: role };
}

function runAuthorize(role, allowed) {
  return new Promise((resolve) => {
    const req = { user: { role } };
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
      },
    };
    authorizeRoles(...allowed)(req, res, () => resolve({ statusCode: 200 }));
  });
}

function baseCandidate(statusHistory) {
  return {
    _id: SUB,
    firstName: 'Asha',
    lastName: 'Rao',
    email: 'asha@example.com',
    mobileNumber: '9999999999',
    dob: null,
    currentLocation: 'Bengaluru',
    currentOrg: 'Northwind',
    ctc: '8 LPA',
    ectc: '12 LPA',
    totalYoe: '4',
    relevantYoe: '3',
    candidateSkills: 'React',
    educationalQualification: 'B.E. Computer Science',
    role: 'Developer',
    recruiterId: [RECRUITER],
    updatedResume: '/uploads/resume.pdf',
    Status: statusHistory,
  };
}

function createHarness({
  candidate,
  associated = [],
  leads = {},
  staleRead = false,
  hrUsers,
  client = null,
  clientTeamLeads = [],
} = {}) {
  const state = {
    offers: [],
    histories: [],
    notifications: [],
    lookups: 0,
    requirementQueries: [],
    updates: 0,
    candidateStatus: JSON.stringify(candidate?.Status || []),
  };
  const candidateRecord = candidate;

  const service = createOfferWorkflowService({
    isEnabled: () => String(process.env.OFFER_WORKFLOW_ENABLED || '').trim().toLowerCase() === 'true',
    prepare: async () => {},
    loadActor: async (tokenUser) => {
      if (!tokenUser?.id) throw new OfferWorkflowError('Authentication required.', 401, 'AUTH_REQUIRED');
      return { id: tokenUser.id, role: tokenUser.role, name: tokenUser.name || tokenUser.role };
    },
    findCandidateContext: async () => {
      state.lookups += 1;
      if (!candidateRecord) return null;
      return {
        main: { _id: OUTER, reqId: 'REG-77', recruiterId: [RECRUITER] },
        candidate: candidateRecord,
      };
    },
    findCandidateIdsByLatestStatus: async (pattern) => {
      if (!candidateRecord || !(pattern instanceof RegExp)) return [];
      const history = Array.isArray(candidateRecord.Status) ? candidateRecord.Status : [];
      const latest = history.reduce((current, entry) => {
        if (!current) return entry;
        return new Date(entry?.Date || 0) >= new Date(current?.Date || 0) ? entry : current;
      }, null);
      return latest && pattern.test(String(latest.Status || '')) ? [String(candidateRecord._id)] : [];
    },
    findLatestCandidateStatusDetails: async (ids) => {
      const wanted = new Set((ids || []).map((id) => String(id || '')).filter(Boolean));
      const details = new Map();
      if (state.candidateStatusDetails instanceof Map) {
        wanted.forEach((id) => {
          if (state.candidateStatusDetails.has(id)) details.set(id, state.candidateStatusDetails.get(id));
        });
        return details;
      }
      if (!candidateRecord || !wanted.has(String(candidateRecord._id))) return details;
      const history = Array.isArray(candidateRecord.Status) ? candidateRecord.Status : [];
      const latest = history.reduce((current, entry) => {
        if (!current) return entry;
        return new Date(entry?.Date || 0) >= new Date(current?.Date || 0) ? entry : current;
      }, null);
      details.set(String(candidateRecord._id), {
        status: latest?.Status || '',
        updatedAt: latest?.Date || null,
      });
      return details;
    },
    findLatestCandidateStatuses: async (ids) => {
      const wanted = new Set((ids || []).map((id) => String(id || '')).filter(Boolean));
      const statuses = new Map();
      if (!candidateRecord || !wanted.has(String(candidateRecord._id))) return statuses;
      const history = Array.isArray(candidateRecord.Status) ? candidateRecord.Status : [];
      const latest = history.reduce((current, entry) => {
        if (!current) return entry;
        return new Date(entry?.Date || 0) >= new Date(current?.Date || 0) ? entry : current;
      }, null);
      statuses.set(String(candidateRecord._id), latest?.Status || '');
      return statuses;
    },
    findOpenOffer: async (subdocumentId) => state.offers.find((offer) => (
      offer.candidateSubdocumentId === subdocumentId && offer.isOpen
    )) || null,
    findTeamLeadsForRecruiters: async () => associated,
    findActiveTeamLead: async (id) => leads[id] || null,
    findActiveUsersByRoles: async (roles = []) => Object.values(leads)
      .filter((person) => person && person.active !== false && roles.includes(person.role))
      .map((person) => ({ id: person.id, name: person.name, role: person.role })),
    findRequirement: async (reqId) => {
      state.requirementQueries.push(reqId);
      return {
        _id: '4'.repeat(24),
        regId: 'REG-77',
        role: 'Developer',
        client: 'Ada Clients',
        clientId: 'CL-9',
        location: 'Hyderabad',
        workMode: 'Hybrid',
        typeOfContract: 'C2H',
        hiringManager: 'Meera',
        skill: 'React',
      };
    },
    findClient: async () => client,
    findActiveTeamLeadsForClient: async (clientId) => (
      client && String(client._id) === String(clientId) ? clientTeamLeads : []
    ),
    allocateOfferNumber: async () => 'ORN-001',
    insertOffer: async (payload) => {
      if (state.failInsert) {
        const error = new Error('E11000 duplicate key');
        error.code = 11000;
        throw error;
      }
      const offer = {
        ...payload,
        _id: `offer-${state.offers.length + 1}`,
        workflowVersion: 0,
      };
      state.offers.push(offer);
      return JSON.parse(JSON.stringify(offer));
    },
    conditionalUpdate: async (offerId, expectedStatus, expectedVersion, setFields) => {
      state.updates += 1;
      const found = state.offers.find((offer) => String(offer._id) === String(offerId));
      if (!found) return null;
      if (found.currentStatus !== expectedStatus || (found.workflowVersion || 0) !== expectedVersion) {
        return null;
      }
      Object.assign(found, setFields);
      found.workflowVersion = (expectedVersion || 0) + 1;
      return JSON.parse(JSON.stringify(found));
    },
    insertHistory: async (record) => {
      const entry = { ...record, _id: `h-${state.histories.length + 1}` };
      state.histories.push(entry);
      return entry;
    },
    queryOffers: async (filter) => {
      state.lastFilter = filter;
      return { items: state.offers, total: state.offers.length };
    },
    countOfferGroups: async (filter) => {
      state.lastCountFilter = filter;
      return [];
    },
    findOfferById: async (offerId) => {
      const found = state.offers.find((offer) => String(offer._id) === String(offerId));
      if (!found) return null;
      if (staleRead) return JSON.parse(JSON.stringify(state.stale || found));
      return JSON.parse(JSON.stringify(found));
    },
    listHistory: async () => state.histories,
    latestReturnComments: async (offerIds) => {
      const wanted = new Set((offerIds || []).map((id) => String(id)));
      const reasons = new Map();
      [...state.histories].reverse().forEach((entry) => {
        const id = String(entry.offerRequestId || '');
        if (!wanted.has(id) || reasons.has(id)) return;
        if (![
          'return_to_tl',
          'return_to_tl_by_md',
          'return_to_hr',
          'return_to_md',
          'admin_return',
          'admin_return_to_tl',
          'admin_return_to_hr',
          'admin_return_to_md',
        ].includes(entry.action)) return;
        const comments = String(entry.comments || '').trim();
        if (comments) reasons.set(id, comments);
      });
      return reasons;
    },
    listOpenOffers: async () => state.offers.filter((offer) => offer.isOpen !== false),
    findLatestOfferForCandidate: async (subdocumentId) => {
      const matches = state.offers.filter((offer) => offer.candidateSubdocumentId === subdocumentId);
      return matches.length ? matches[matches.length - 1] : null;
    },
    listClosedWorkflowOffers: async () => state.offers.filter((offer) => (
      offer.isOpen === false && ['Joined', 'Candidate Declined'].includes(offer.currentStatus)
    )),
    findActiveUsersByRole: async (role) => {
      if (role === 'HR') return hrUsers || [{ id: HR }];
      if (role === 'MD') return [{ id: MD }];
      if (role === 'Admin') return [{ id: ADMIN }];
      return [];
    },
    fileExists: async (storageKey) => {
      state.fileReads = (state.fileReads || 0) + 1;
      return resolvePrivateDocumentPath(storageKey, path.join(__dirname, 'offer-test-files'));
    },
    notify: async (payload) => {
      const duplicate = state.notifications.some((item) => (
        item.sourceEventId === payload.sourceEventId && item.recipientUserId === payload.recipientUserId
      ));
      if (duplicate) {
        const error = new Error('duplicate');
        error.code = 11000;
        throw error;
      }
      state.notifications.push(payload);
      return { created: true, duplicate: false };
    },
    createId: () => `doc-${state.offers.reduce((count, offer) => count + (offer.documents || []).length, 0) + 1}`,
    appendCandidateStatus: async ({ candidateSubdocumentId, status, remark, actor }) => {
      state.candidateSyncAttempts = (state.candidateSyncAttempts || 0) + 1;
      if (state.failCandidateSyncTimes > 0) {
        state.failCandidateSyncTimes -= 1;
        throw new Error('candidate write failed');
      }
      if (!candidateRecord || String(candidateRecord._id) !== String(candidateSubdocumentId)) {
        throw new OfferWorkflowError('Candidate not found in any main document', 404, 'CANDIDATE_NOT_FOUND');
      }
      const trimmed = String(remark || '').trim();
      if (status === 'Candidate Declined' && !trimmed) {
        throw new OfferWorkflowError(
          'Remark is required when status is Candidate Declined.',
          400,
          'COMMENTS_REQUIRED',
        );
      }
      const previous = Array.isArray(candidateRecord.Status) ? candidateRecord.Status.slice() : [];
      candidateRecord.Status = previous.concat([{
        Status: status,
        Date: new Date().toISOString(),
        Remark: trimmed,
      }]);
      if (status === 'Candidate Declined') {
        candidateRecord.rejectionStage = 'Offer Declined';
        candidateRecord.rejectedDate = new Date().toISOString();
        candidateRecord.rejectedBy = actor?.id || '';
        candidateRecord.rejectedByName = actor?.name || '';
        candidateRecord.rejectionReason = trimmed;
      }
      state.candidateStatusWrites = (state.candidateStatusWrites || 0) + 1;
      return { appended: true, status };
    },
  });

  return { service, state, candidate: candidateRecord };
}

function eligibleCandidate() {
  return baseCandidate([
    { Status: 'Joined', Date: '2026-01-01T00:00:00.000Z' },
    { Status: 'Offer to be released', Date: '2026-03-01T00:00:00.000Z' },
  ]);
}

async function expectError(fn, code) {
  try {
    await fn();
  } catch (error) {
    assert.strictEqual(error.code, code, error.message);
    return error;
  }
  throw new Error(`Expected ${code}`);
}

(async () => {
  assert.strictEqual(formatOfferRequestNumber(1), 'ORN-001');
  assert.strictEqual(formatOfferRequestNumber(2), 'ORN-002');
  assert.strictEqual(formatOfferRequestNumber(3), 'ORN-003');
  assert.strictEqual(formatOfferRequestNumber(1000), 'ORN-1000');
  assert.deepStrictEqual(EXISTING_USER_TYPES, ['Admin', 'TeamLead', 'User']);
  assert.deepStrictEqual(USER_TYPES, ['Admin', 'TeamLead', 'User', 'HR']);
  ['Admin', 'TeamLead', 'User', 'HR'].forEach((role) => {
    assert.ok(ALLOWED_USER_TYPES.has(role));
  });
  assert.strictEqual(ALLOWED_USER_TYPES.has('MD'), false);

  assert.strictEqual((await runAuthorize('Admin', ['Admin'])).statusCode, 200);
  assert.strictEqual((await runAuthorize('TeamLead', ['TeamLead'])).statusCode, 200);
  assert.strictEqual((await runAuthorize('User', ['User'])).statusCode, 200);
  assert.strictEqual((await runAuthorize('HR', ['Admin'])).statusCode, 403);
  assert.strictEqual((await runAuthorize('MD', ['Admin', 'TeamLead', 'User'])).statusCode, 403);
  assert.strictEqual((await runAuthorize('HR', ['HR'])).statusCode, 200);

  const snapshot = buildCandidateSnapshot(eligibleCandidate());
  assert.strictEqual(snapshot.currentAddress, '');
  assert.strictEqual(snapshot.permanentAddress, '');
  assert.strictEqual(snapshot.currentCompany, 'Northwind');
  assert.strictEqual(snapshot.firstName, 'Asha');

  const single = resolveTeamLeadSelection({
    associatedTeamLeads: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
  });
  assert.strictEqual(single.ok, true);
  assert.strictEqual(single.mode, 'single_assigned');

  const wrongSingle = resolveTeamLeadSelection({
    associatedTeamLeads: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
    selectedTeamLead: { id: TL_TWO, name: 'Other', role: 'TeamLead', active: true },
  });
  assert.strictEqual(wrongSingle.code, 'TEAM_LEAD_NOT_ASSOCIATED');

  const multiple = resolveTeamLeadSelection({
    associatedTeamLeads: [
      { id: TL, name: 'Lata', role: 'TeamLead', active: true },
      { id: TL_TWO, name: 'Kiran', role: 'TeamLead', active: true },
    ],
  });
  assert.strictEqual(multiple.code, 'TEAM_LEAD_SELECTION_REQUIRED');
  assert.strictEqual(multiple.details.reason, 'multiple');

  const picked = resolveTeamLeadSelection({
    associatedTeamLeads: [
      { id: TL, name: 'Lata', role: 'TeamLead', active: true },
      { id: TL_TWO, name: 'Kiran', role: 'TeamLead', active: true },
    ],
    selectedTeamLead: { id: TL_TWO, name: 'Kiran', role: 'TeamLead', active: true },
  });
  assert.strictEqual(picked.mode, 'selected_associated');

  const outsider = resolveTeamLeadSelection({
    associatedTeamLeads: [
      { id: TL, name: 'Lata', role: 'TeamLead', active: true },
      { id: TL_TWO, name: 'Kiran', role: 'TeamLead', active: true },
    ],
    selectedTeamLead: { id: USER, name: 'Nope', role: 'TeamLead', active: true },
  });
  assert.strictEqual(outsider.code, 'TEAM_LEAD_NOT_ASSOCIATED');

  const override = resolveTeamLeadSelection({
    associatedTeamLeads: [],
    selectedTeamLead: { id: TL, name: 'Lata', role: 'TeamLead', active: true },
  });
  assert.strictEqual(override.mode, 'admin_override_unassigned');

  const inactive = resolveTeamLeadSelection({
    associatedTeamLeads: [],
    selectedTeamLead: { id: TL, name: 'Lata', role: 'TeamLead', active: false },
  });
  assert.strictEqual(inactive.code, 'INVALID_TEAM_LEAD');

  const selectedHr = resolveTeamLeadSelection({
    associatedTeamLeads: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
    selectedTeamLead: { id: HR, name: 'Meera', role: 'HR', active: true },
  });
  assert.strictEqual(selectedHr.ok, true);
  assert.strictEqual(selectedHr.mode, 'admin_selected_hr');
  assert.strictEqual(selectedHr.teamLead.id, HR);

  const inactiveHr = resolveTeamLeadSelection({
    associatedTeamLeads: [],
    selectedTeamLead: { id: HR, name: 'Meera', role: 'HR', active: false },
  });
  assert.strictEqual(inactiveHr.code, 'INVALID_TEAM_LEAD');

  const billable = calculateCommercials({
    classification: 'Billable',
    monthlyBillingRate: 100,
    monthlyCtcCost: 10.1,
    employerPfEsiCost: 20.2,
    otherApprovedMonthlyCosts: 0.05,
  });
  assert.strictEqual(billable.monthlyTotalCost, 10.1);
  assert.strictEqual(billable.monthlyMargin, 89.9);
  assert.strictEqual(billable.marginPercentage, 89.9);
  assert.strictEqual(billable.marginStatus, 'calculated');

  const negative = calculateCommercials({
    classification: 'Billable',
    monthlyBillingRate: 100,
    monthlyCtcCost: 80,
    employerPfEsiCost: 30,
    otherApprovedMonthlyCosts: 0,
  });
  assert.strictEqual(negative.monthlyTotalCost, 80);
  assert.strictEqual(negative.monthlyMargin, 20);
  assert.strictEqual(negative.marginPercentage, 20);

  const zeroBilling = calculateCommercials({
    classification: 'Billable',
    monthlyBillingRate: 0,
    monthlyCtcCost: 10,
    employerPfEsiCost: 0,
    otherApprovedMonthlyCosts: 0,
  });
  assert.strictEqual(zeroBilling.monthlyMargin, null);
  assert.strictEqual(zeroBilling.marginStatus, 'not_applicable');

  const administrative = calculateCommercials({
    classification: 'Administrative',
    monthlyBillingRate: 500,
    monthlyCtcCost: 40,
    employerPfEsiCost: 5,
    otherApprovedMonthlyCosts: 0,
  });
  assert.strictEqual(administrative.monthlyTotalCost, 40);
  assert.strictEqual(administrative.monthlyMargin, 460);
  assert.strictEqual(administrative.marginStatus, 'calculated');

  assert.throws(
    () => calculateCommercials({ classification: 'Billable', monthlyCtcCost: -1 }),
    /cannot be negative/,
  );

  const ineligible = createHarness({
    candidate: baseCandidate([{ Status: 'Joined', Date: '2026-04-01T00:00:00.000Z' }]),
    associated: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
  });
  await expectError(
    () => ineligible.service.initiateOffer({ tokenUser: actor(ADMIN, 'Admin'), candidateSubdocumentId: SUB }),
    'CANDIDATE_NOT_ELIGIBLE',
  );
  assert.strictEqual(ineligible.state.offers.length, 0);
  assert.strictEqual(JSON.stringify(ineligible.candidate.Status), ineligible.state.candidateStatus);

  const open = createHarness({
    candidate: eligibleCandidate(),
    associated: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
  });
  open.state.offers.push({
    _id: 'offer-open',
    offerRequestNumber: 'ORN-009',
    candidateSubdocumentId: SUB,
    isOpen: true,
    currentStatus: 'TL Review',
    requirementBusinessId: 'REG-77',
  });
  const openError = await expectError(
    () => open.service.initiateOffer({ tokenUser: actor(ADMIN, 'Admin'), candidateSubdocumentId: SUB }),
    'OPEN_OFFER_EXISTS',
  );
  assert.strictEqual(open.state.offers.length, 1);
  assert.strictEqual(openError.details.offerId, 'offer-open');
  assert.strictEqual(openError.details.offerRequestNumber, 'ORN-009');

  const closed = createHarness({
    candidate: eligibleCandidate(),
    associated: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
    leads: { [TL]: { id: TL, name: 'Lata', role: 'TeamLead', active: true } },
  });
  closed.state.offers.push({ candidateSubdocumentId: SUB, isOpen: false, currentStatus: 'Candidate Declined' });
  const reopened = await closed.service.initiateOffer({
    tokenUser: actor(ADMIN, 'Admin'),
    candidateSubdocumentId: SUB,
    recipientUserId: TL,
  });
  assert.strictEqual(reopened.offer.candidateSubdocumentId, SUB);
  assert.strictEqual(reopened.offer.candidateDocumentId, OUTER);
  assert.notStrictEqual(reopened.offer.candidateDocumentId, reopened.offer.candidateSubdocumentId);

  const needsChoice = createHarness({
    candidate: eligibleCandidate(),
    associated: [
      { id: TL, name: 'Lata', role: 'TeamLead', active: true },
      { id: TL_TWO, name: 'Kiran', role: 'TeamLead', active: true },
    ],
    leads: {
      [TL]: { id: TL, name: 'Lata', role: 'TeamLead', active: true },
      [TL_TWO]: { id: TL_TWO, name: 'Kiran', role: 'TeamLead', active: true },
      [HR]: { id: HR, name: 'Meera', role: 'HR', active: true },
    },
  });
  await expectError(
    () => needsChoice.service.initiateOffer({ tokenUser: actor(ADMIN, 'Admin'), candidateSubdocumentId: SUB }),
    'RECIPIENT_REQUIRED',
  );
  assert.strictEqual(needsChoice.state.offers.length, 0);
  const adminRecipients = await needsChoice.service.listInitiationRecipients({ tokenUser: actor(ADMIN, 'Admin') });
  assert.strictEqual(adminRecipients.defaultRecipientUserId, '');
  assert.deepStrictEqual(adminRecipients.recipients.map((person) => person.role).sort(), ['HR', 'TeamLead', 'TeamLead']);
  const hrRecipients = await needsChoice.service.listInitiationRecipients({ tokenUser: actor(HR, 'HR') });
  assert.strictEqual(hrRecipients.defaultRecipientUserId, '');
  assert.deepStrictEqual(hrRecipients.recipients.map((person) => person.role).sort(), ['HR', 'TeamLead', 'TeamLead']);

  const badChoice = createHarness({
    candidate: eligibleCandidate(),
    associated: [
      { id: TL, name: 'Lata', role: 'TeamLead', active: true },
      { id: TL_TWO, name: 'Kiran', role: 'TeamLead', active: true },
    ],
    leads: { [USER]: { id: USER, name: 'Rec', role: 'User', active: true } },
  });
  await expectError(
    () => badChoice.service.initiateOffer({
      tokenUser: actor(ADMIN, 'Admin'),
      candidateSubdocumentId: SUB,
      recipientUserId: USER,
    }),
    'INVALID_RECIPIENT',
  );
  assert.strictEqual(badChoice.state.offers.length, 0);

  const inactiveRecipient = createHarness({
    candidate: eligibleCandidate(),
    associated: [],
    leads: { [TL]: { id: TL, name: 'Lata', role: 'TeamLead', active: false } },
  });
  await expectError(
    () => inactiveRecipient.service.initiateOffer({
      tokenUser: actor(ADMIN, 'Admin'),
      candidateSubdocumentId: SUB,
      recipientUserId: TL,
    }),
    'INVALID_RECIPIENT',
  );

  const missingLead = createHarness({
    candidate: eligibleCandidate(),
    associated: [],
    leads: {},
  });
  await expectError(
    () => missingLead.service.initiateOffer({
      tokenUser: actor(ADMIN, 'Admin'),
      candidateSubdocumentId: SUB,
      recipientUserId: TL,
    }),
    'INVALID_RECIPIENT',
  );

  const CLIENT_ID = 'c'.repeat(24);
  const clientLead = { id: TL, name: 'Lata', role: 'TeamLead', active: true };
  const otherLead = { id: 'e'.repeat(24), name: 'Pooja', role: 'TeamLead', active: true };
  const hrPerson = { id: HR, name: 'Meera', role: 'HR', active: true };
  const assignmentLeads = {
    [TL]: clientLead,
    [otherLead.id]: otherLead,
    [HR]: hrPerson,
  };
  const assignedClient = createHarness({
    candidate: eligibleCandidate(),
    client: { _id: CLIENT_ID, ClientName: 'Northwind' },
    clientTeamLeads: [clientLead],
    leads: assignmentLeads,
  });
  const defaults = await assignedClient.service.listInitiationRecipients({
    tokenUser: actor(ADMIN, 'Admin'),
    candidateSubdocumentId: SUB,
  });
  assert.strictEqual(defaults.defaultRecipientUserId, TL);
  assert.ok(defaults.recipients.some((person) => person.id === HR && person.role === 'HR'));
  assert.ok(defaults.recipients.some((person) => person.id === otherLead.id));
  const hrDefaults = await assignedClient.service.listInitiationRecipients({
    tokenUser: actor(HR, 'HR'),
    candidateSubdocumentId: SUB,
  });
  assert.strictEqual(hrDefaults.defaultRecipientUserId, TL);

  const noClientLead = createHarness({
    candidate: eligibleCandidate(),
    client: { _id: CLIENT_ID, ClientName: 'Northwind' },
    clientTeamLeads: [],
    leads: assignmentLeads,
  });
  const blankDefault = await noClientLead.service.listInitiationRecipients({
    tokenUser: actor(ADMIN, 'Admin'),
    candidateSubdocumentId: SUB,
  });
  assert.strictEqual(blankDefault.defaultRecipientUserId, '');

  const inactiveClientLead = createHarness({
    candidate: eligibleCandidate(),
    client: { _id: CLIENT_ID, ClientName: 'Northwind' },
    clientTeamLeads: [{ ...clientLead, active: false }],
    leads: assignmentLeads,
  });
  const inactiveDefault = await inactiveClientLead.service.listInitiationRecipients({
    tokenUser: actor(HR, 'HR'),
    candidateSubdocumentId: SUB,
  });
  assert.strictEqual(inactiveDefault.defaultRecipientUserId, '');

  const severalClientLeads = createHarness({
    candidate: eligibleCandidate(),
    client: { _id: CLIENT_ID, ClientName: 'Northwind' },
    clientTeamLeads: [clientLead, otherLead],
    leads: assignmentLeads,
  });
  const ambiguousDefault = await severalClientLeads.service.listInitiationRecipients({
    tokenUser: actor(ADMIN, 'Admin'),
    candidateSubdocumentId: SUB,
  });
  assert.strictEqual(ambiguousDefault.defaultRecipientUserId, '');

  const manualTl = await assignedClient.service.initiateOffer({
    tokenUser: actor(ADMIN, 'Admin'),
    candidateSubdocumentId: SUB,
    recipientUserId: otherLead.id,
  });
  assert.strictEqual(manualTl.offer.currentAssigneeUserId, otherLead.id);
  assert.strictEqual(manualTl.offer.currentAssigneeRole, 'TeamLead');
  assert.strictEqual(manualTl.offer.responsibleTeamLeadUserId, otherLead.id);
  const reopenedManualTl = await assignedClient.service.getOffer({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: manualTl.offer.id,
  });
  assert.strictEqual(reopenedManualTl.offer.currentAssigneeUserId, otherLead.id);
  assert.strictEqual(reopenedManualTl.offer.currentAssigneeName, 'Pooja');

  const manualHrRun = createHarness({
    candidate: eligibleCandidate(),
    client: { _id: CLIENT_ID, ClientName: 'Northwind' },
    clientTeamLeads: [clientLead],
    leads: assignmentLeads,
  });
  const manualHr = await manualHrRun.service.initiateOffer({
    tokenUser: actor(ADMIN, 'Admin'),
    candidateSubdocumentId: SUB,
    recipientUserId: HR,
  });
  assert.strictEqual(manualHr.offer.currentAssigneeUserId, HR);
  assert.strictEqual(manualHr.offer.currentAssigneeRole, 'HR');

  const selfAssignRun = createHarness({
    candidate: eligibleCandidate(),
    client: { _id: CLIENT_ID, ClientName: 'Northwind' },
    clientTeamLeads: [clientLead],
    leads: assignmentLeads,
  });
  const selfAssigned = await selfAssignRun.service.initiateOffer({
    tokenUser: actor(HR, 'HR'),
    candidateSubdocumentId: SUB,
    recipientUserId: HR,
  });
  assert.strictEqual(selfAssigned.offer.currentAssigneeUserId, HR);
  assert.strictEqual(selfAssigned.offer.initiatedByUserId, HR);

  const overrideRun = createHarness({
    candidate: eligibleCandidate(),
    associated: [],
    leads: { [TL]: { id: TL, name: 'Lata', role: 'TeamLead', active: true } },
  });
  const overridden = await overrideRun.service.initiateOffer({
    tokenUser: { ...actor(ADMIN, 'Admin'), actorRole: 'MD' },
    candidateSubdocumentId: SUB,
    recipientUserId: TL,
  });
  assert.strictEqual(overridden.offer.currentStatus, 'Initiated');
  assert.strictEqual(overridden.offer.initiationRoute, 'TL_REVIEW');
  assert.strictEqual(overridden.offer.teamLeadSelectionMode, 'admin_override_unassigned');
  assert.strictEqual(overridden.offer.responsibleTeamLeadUserId, TL);
  assert.strictEqual(overridden.offer.candidateDocumentId, OUTER);
  assert.strictEqual(overridden.offer.candidateSubdocumentId, SUB);
  assert.strictEqual(overridden.offer.sourceReqId, 'REG-77');
  assert.strictEqual(overridden.offer.requirementBusinessId, 'REG-77');
  assert.strictEqual(overridden.offer.client.clientName, 'Ada Clients');
  assert.strictEqual(overridden.offer.client.projectDetails, undefined);
  assert.deepStrictEqual(overrideRun.state.requirementQueries, ['REG-77']);
  assert.strictEqual(JSON.stringify(overrideRun.candidate.Status), overrideRun.state.candidateStatus);
  assert.strictEqual(overrideRun.state.histories[0].actorRole, 'Admin');
  assert.strictEqual(overrideRun.state.histories[0].actorUserId, ADMIN);
  assert.strictEqual(overrideRun.state.histories[1].action, 'assign_to_tl');
  assert.strictEqual(overrideRun.state.histories[1].newStatus, 'Initiated');
  assert.strictEqual(overridden.offer._id, overrideRun.state.offers[0]._id);
  assert.strictEqual(overrideRun.state.notifications.length, 1);
  assert.strictEqual(overrideRun.state.notifications[0].recipientUserId, TL);
  assert.ok(overrideRun.state.notifications[0].sourceEventId.startsWith('offer:'));
  const hrAssigned = createHarness({
    candidate: eligibleCandidate(),
    associated: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
    leads: { [HR]: { id: HR, name: 'Meera', role: 'HR', active: true } },
  });
  const hrOffer = await hrAssigned.service.initiateOffer({
    tokenUser: actor(ADMIN, 'Admin'),
    candidateSubdocumentId: SUB,
    recipientUserId: HR,
    initiationRoute: 'tl',
  });
  assert.strictEqual(hrOffer.offer.teamLeadSelectionMode, 'selected_hr');
  assert.strictEqual(hrOffer.offer.initiationRoute, 'DIRECT_TO_HR');
  assert.strictEqual(hrOffer.offer.responsibleTeamLeadUserId, TL);
  assert.strictEqual(hrOffer.offer.currentAssigneeRole, 'HR');
  assert.strictEqual(hrOffer.offer.currentAssigneeUserId, HR);
  assert.strictEqual(hrOffer.offer.currentStatus, 'HR Review');
  assert.strictEqual(hrOffer.offer.tlStageSkipped, true);
  assert.strictEqual(hrAssigned.state.notifications.length, 1);
  assert.strictEqual(hrAssigned.state.notifications[0].recipientUserId, HR);
  assert.strictEqual(hrAssigned.state.histories[0].comments, 'Admin initiated the offer directly to Meera (HR).');

  const hrInit = createHarness({
    candidate: eligibleCandidate(),
    associated: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
    leads: {
      [TL]: { id: TL, name: 'Lata', role: 'TeamLead', active: true },
      [HR]: { id: HR, name: 'Meera', role: 'HR', active: true },
    },
  });
  const hrCreated = await hrInit.service.initiateOffer({
    tokenUser: actor(HR, 'HR'),
    candidateSubdocumentId: SUB,
    recipientUserId: TL,
    draft: {
      candidate: { currentAddress: '12 MG Road', email: 'asha.updated@example.com' },
      additionalRemarks: 'Ready for TL review',
    },
  });
  assert.strictEqual(hrCreated.canOpen, true);
  assert.strictEqual(hrCreated.offer.candidateSnapshot.currentAddress, '12 MG Road');
  assert.strictEqual(hrCreated.offer.currentStatus, 'Initiated');
  const hrCreatedRecord = hrInit.state.offers[0];
  assert.strictEqual(hrCreatedRecord.initiatedByRole, 'HR');
  assert.strictEqual(hrCreatedRecord.initiatedByUserId, HR);
  assert.strictEqual(hrCreatedRecord.initiationRoute, 'TL_REVIEW');
  assert.strictEqual(hrCreatedRecord.currentStatus, 'Initiated');
  assert.strictEqual(hrCreatedRecord.responsibleTeamLeadUserId, TL);
  assert.strictEqual(hrCreatedRecord.currentAssigneeUserId, TL);
  assert.strictEqual(hrCreatedRecord.currentAssigneeRole, 'TeamLead');
  assert.strictEqual(hrCreatedRecord.candidateSnapshot.currentAddress, '12 MG Road');
  assert.strictEqual(hrCreatedRecord.candidateSnapshot.email, 'asha.updated@example.com');
  assert.strictEqual(hrCreatedRecord.candidateSnapshot.firstName, 'Asha');
  assert.strictEqual(hrCreatedRecord.additionalRemarks, 'Ready for TL review');
  assert.strictEqual(hrCreated.offer.currentStatus, 'Initiated');
  assert.strictEqual(hrCreated.offer.currentAssigneeRole, 'TeamLead');
  assert.strictEqual(hrInit.state.notifications.length, 1);
  assert.strictEqual(hrInit.state.notifications[0].recipientUserId, TL);

  const HR_TWO = '9'.repeat(24);
  const hrToHr = createHarness({
    candidate: eligibleCandidate(),
    associated: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
    leads: {
      [HR]: { id: HR, name: 'Meera', role: 'HR', active: true },
      [HR_TWO]: { id: HR_TWO, name: 'Nisha', role: 'HR', active: true },
    },
  });
  const hrAssignedByHr = await hrToHr.service.initiateOffer({
    tokenUser: actor(HR, 'HR'),
    candidateSubdocumentId: SUB,
    recipientUserId: HR_TWO,
    initiationRoute: 'tl',
  });
  assert.strictEqual(hrAssignedByHr.offer.currentStatus, 'HR Review');
  assert.strictEqual(hrAssignedByHr.offer.initiationRoute, 'DIRECT_TO_HR');
  assert.strictEqual(hrAssignedByHr.offer.tlStageSkipped, true);
  assert.strictEqual(hrAssignedByHr.offer.currentAssigneeUserId, HR_TWO);
  assert.strictEqual(hrAssignedByHr.offer.responsibleHrUserId, HR_TWO);
  assert.strictEqual(hrAssignedByHr.offer.candidateSnapshot.firstName, 'Asha');
  assert.strictEqual(hrToHr.state.notifications.length, 1);
  assert.strictEqual(hrToHr.state.notifications[0].recipientUserId, HR_TWO);
  assert.strictEqual(JSON.stringify(hrToHr.candidate.Status), hrToHr.state.candidateStatus);
  const indicators = await hrToHr.service.listOpenOfferIndicators({ tokenUser: actor(TL, 'TeamLead') }).catch((error) => error);
  assert.strictEqual(indicators.code, 'OFFER_FORBIDDEN');
  const hrIndicators = await hrToHr.service.listOpenOfferIndicators({ tokenUser: actor(HR, 'HR') });
  assert.strictEqual(hrIndicators.length, 1);
  assert.strictEqual(hrIndicators[0].offerRequestNumber, 'ORN-001');
  assert.strictEqual(hrIndicators[0].canOpen, true);
  assert.strictEqual(hrIndicators[0].candidateName, undefined);
  assert.strictEqual(hrIndicators[0].email, undefined);
  const hiddenFromHr = createHarness({
    candidate: eligibleCandidate(),
    associated: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
    leads: { [TL]: { id: TL, name: 'Lata', role: 'TeamLead', active: true } },
  });
  hiddenFromHr.state.offers.push({
    _id: 'offer-hidden',
    offerRequestNumber: 'ORN-010',
    candidateSubdocumentId: SUB,
    currentStatus: 'Initiated',
    currentAssigneeRole: 'TeamLead',
    currentAssigneeUserId: TL,
    responsibleTeamLeadUserId: TL,
    isOpen: true,
    candidateSnapshot: { email: 'secret@example.com', firstName: 'Asha' },
  });
  const masked = await hiddenFromHr.service.listOpenOfferIndicators({ tokenUser: actor(HR, 'HR') });
  assert.strictEqual(masked[0].canOpen, true);
  assert.strictEqual(masked[0].offerId, 'offer-hidden');
  assert.strictEqual(masked[0].offerRequestNumber, 'ORN-010');
  assert.strictEqual(masked[0].currentStatus, 'Initiated');
  const openedHidden = await hiddenFromHr.service.getOffer({ tokenUser: actor(HR, 'HR'), offerId: 'offer-hidden' });
  assert.strictEqual(openedHidden.offer.currentStatus, 'Initiated');
  assert.strictEqual(openedHidden.offer.candidateSnapshot.firstName, 'Asha');

  const directHr = createHarness({
    candidate: eligibleCandidate(),
    associated: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
    leads: { [HR]: { id: HR, name: 'Meera', role: 'HR', active: true } },
  });
  const directCreated = await directHr.service.initiateOffer({
    tokenUser: actor(ADMIN, 'Admin'),
    candidateSubdocumentId: SUB,
    recipientUserId: HR,
    initiationRoute: 'direct_hr',
  });
  assert.strictEqual(directCreated.offer.initiationRoute, 'DIRECT_TO_HR');
  assert.strictEqual(directCreated.offer.tlStageSkipped, true);
  assert.strictEqual(directCreated.offer.currentStatus, 'HR Review');
  assert.strictEqual(directCreated.offer.currentAssigneeRole, 'HR');
  assert.strictEqual(directCreated.offer.currentAssigneeUserId, HR);
  assert.strictEqual(directCreated.offer.teamLeadSelectionMode, 'selected_hr');
  assert.strictEqual(directHr.state.notifications[0].recipientUserId, HR);

  const tlDenied = createHarness({
    candidate: eligibleCandidate(),
    associated: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
  });
  await expectError(
    () => tlDenied.service.initiateOffer({ tokenUser: actor(TL, 'TeamLead'), candidateSubdocumentId: SUB }),
    'OFFER_FORBIDDEN',
  );

  assert.strictEqual(overridden.offer.candidateSnapshot.currentAddress, '');
  assert.strictEqual(overridden.offer.documents.length, 0);

  process.env.OFFER_WORKFLOW_ENABLED = 'false';
  const disabled = createHarness({
    candidate: eligibleCandidate(),
    associated: [{ id: TL, name: 'Lata', role: 'TeamLead', active: true }],
  });
  await expectError(
    () => disabled.service.initiateOffer({ tokenUser: actor(ADMIN, 'Admin'), candidateSubdocumentId: SUB }),
    'OFFER_WORKFLOW_DISABLED',
  );
  assert.strictEqual(disabled.state.lookups, 0);
  process.env.OFFER_WORKFLOW_ENABLED = 'true';

  const recruiterList = createHarness({ candidate: eligibleCandidate() });
  await expectError(
    () => recruiterList.service.listOffers({ tokenUser: actor(USER, 'User'), query: {} }),
    'OFFER_FORBIDDEN',
  );

  const tlOffer = {
    _id: 'offer-tl',
    offerRequestNumber: 'ORR-2026-0007',
    candidateDocumentId: OUTER,
    candidateSubdocumentId: SUB,
    responsibleTeamLeadUserId: TL,
    responsibleTeamLeadName: 'Lata',
    currentAssigneeUserId: TL,
    currentAssigneeRole: 'TeamLead',
    currentAssigneeName: 'Lata',
    currentStatus: 'TL Review',
    isOpen: true,
    workflowVersion: 2,
    sourceSnapshot: { candidate: { firstName: 'Asha' } },
    candidateSnapshot: {
      firstName: 'Asha',
      lastName: 'Rao',
      email: 'asha@example.com',
      mobileNumber: '9999999999',
      currentAddress: '',
      permanentAddress: '',
      currentCompany: 'Northwind',
      technicalSkills: 'React',
    },
    employment: {
      employmentCategory: '',
      currentCompany: 'Northwind',
      classification: 'Billable',
      employmentType: 'Full time',
      offerType: 'Consulting',
      workMode: '',
    },
    client: { clientId: 'CL-9', clientName: 'Ada Clients', clientLocation: '', projectDetails: 'REG-77 · Developer' },
    commercial: {
      monthlyBillingRate: null,
      monthlyCtcCost: null,
      employerPfEsiCost: null,
      otherApprovedMonthlyCosts: null,
      monthlyTotalCost: 0,
      monthlyMargin: 999,
      marginPercentage: 99,
      marginStatus: 'calculated',
      commercialRemarks: '',
    },
    documents: [],
    additionalRemarks: '',
  };

  const draftRun = createHarness({ candidate: eligibleCandidate() });
  draftRun.state.offers.push(JSON.parse(JSON.stringify(tlOffer)));
  const saved = await draftRun.service.saveDraft({
    tokenUser: actor(TL, 'TeamLead'),
    offerId: 'offer-tl',
    payload: {
      candidate: { currentAddress: '12 MG Road', permanentAddress: '12 MG Road' },
      education: [{ qualification: 'Should not be stored' }],
      employment: { employmentCategory: 'Fresher', monthlyCtc: 600000 },
      commercial: {
        monthlyBillingRate: 100000,
        monthlyCtcCost: 1,
        employerPfEsiCost: 6000,
        otherApprovedMonthlyCosts: 0,
        monthlyMargin: 1,
        marginPercentage: 1,
        monthlyTotalCost: 1,
      },
    },
  });
  assert.strictEqual(saved.offer.employment.monthlyCtc, 600000);
  assert.strictEqual(saved.offer.commercial.monthlyCtcCost, 50000);
  assert.strictEqual(saved.offer.commercial.monthlyTotalCost, 50000);
  assert.strictEqual(saved.offer.commercial.monthlyMargin, 50000);
  assert.strictEqual(saved.offer.commercial.marginPercentage, 50);
  assert.strictEqual(saved.offer.commercial.employerPfEsiCost, null);
  assert.strictEqual(saved.offer.commercial.otherApprovedMonthlyCosts, null);
  assert.strictEqual(saved.offer.sourceSnapshot.candidate.firstName, 'Asha');
  assert.strictEqual(saved.offer.candidateSnapshot.currentAddress, '12 MG Road');
  assert.strictEqual(saved.offer.education, undefined);
  assert.strictEqual(saved.offer.employment.employmentType, undefined);
  assert.strictEqual(saved.offer.employment.offerType, undefined);
  assert.strictEqual(saved.offer.employment.classification, 'Billable');
  assert.strictEqual(saved.offer.client.projectDetails, undefined);
  assert.strictEqual(saved.offer.client.clientName, 'Ada Clients');
  assert.strictEqual(saved.offer.currentStatus, 'TL Review');
  assert.strictEqual(saved.offer._id, 'offer-tl');
  assert.strictEqual(draftRun.state.histories.length, 0);
  assert.strictEqual(draftRun.state.offers[0].sourceSnapshot.candidate.firstName, 'Asha');

  const fresh = JSON.parse(JSON.stringify(tlOffer));
  fresh._id = 'offer-new';
  fresh.currentStatus = 'Initiated';
  fresh.workflowVersion = 0;
  const startRun = createHarness({ candidate: eligibleCandidate() });
  startRun.state.offers.push(fresh);
  const started = await startRun.service.saveDraft({
    tokenUser: actor(TL, 'TeamLead'),
    offerId: 'offer-new',
    payload: { candidate: { currentAddress: '12 MG Road', permanentAddress: '12 MG Road' } },
  });
  assert.strictEqual(started.offer._id, 'offer-new');
  assert.strictEqual(started.offer.currentStatus, 'TL Review');
  assert.strictEqual(startRun.state.histories[0].action, 'save_draft');
  assert.strictEqual(startRun.state.histories[0].previousStatus, 'Initiated');
  assert.strictEqual(startRun.state.histories[0].newStatus, 'TL Review');

  await expectError(
    () => draftRun.service.saveDraft({
      tokenUser: actor(TL_TWO, 'TeamLead'),
      offerId: 'offer-tl',
      payload: { candidate: { currentAddress: 'Nope' } },
    }),
    'OFFER_FORBIDDEN',
  );

  const hrView = createHarness({ candidate: eligibleCandidate() });
  hrView.state.offers.push(JSON.parse(JSON.stringify(tlOffer)));
  const hrOpened = await hrView.service.getOffer({ tokenUser: actor(HR, 'HR'), offerId: 'offer-tl' });
  assert.strictEqual(hrOpened.offer.currentStatus, 'TL Review');
  const hrEdited = await hrView.service.saveDraft({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    payload: { candidate: { currentAddress: 'Nope' } },
  });
  assert.strictEqual(hrEdited.offer.currentStatus, 'TL Review');
  assert.strictEqual(hrEdited.offer.candidateSnapshot.currentAddress, 'Nope');

  function completeReviewOffer(status, assigneeRole) {
    const offer = JSON.parse(JSON.stringify(tlOffer));
    offer.currentStatus = status;
    offer.currentAssigneeRole = assigneeRole;
    offer.candidateSnapshot.currentAddress = '12 MG Road';
    offer.candidateSnapshot.permanentAddress = '12 MG Road';
    offer.employment = {
      employmentCategory: 'Experienced',
      currentCompany: 'Northwind',
      proposedDesignation: 'Developer',
      classification: 'Billable',
      workLocation: 'Hyderabad',
      workMode: 'Hybrid',
      contractType: 'C2H',
      reportingManager: 'Meera',
      responsibilities: 'Build features',
      totalExperience: '4',
      relevantExperience: '3',
      proposedJoiningDate: '2026-11-01T00:00:00.000Z',
      agreedAnnualCtc: 600000,
      monthlyCtc: 50000,
    };
    offer.commercial = {
      monthlyBillingRate: 100000,
      monthlyCtcCost: 50000,
      employerPfEsiCost: 6000,
      otherApprovedMonthlyCosts: 0,
      monthlyTotalCost: 50000,
      monthlyMargin: 50000,
      marginPercentage: 50,
      marginStatus: 'calculated',
      commercialRemarks: '',
    };
    offer.hrRemarks = 'Check PAN';
    offer.mdRemarks = 'Looks fine';
    offer.documents = completeRequiredDocuments(offer.employment.employmentCategory);
    return offer;
  }

  const hrDirectApproval = createHarness({ candidate: eligibleCandidate() });
  hrDirectApproval.state.offers.push(completeReviewOffer('TL Review', 'TeamLead'));
  await expectError(
    () => hrDirectApproval.service.applyTransition({
      tokenUser: actor(TL, 'TeamLead'),
      offerId: 'offer-tl',
      action: 'verify_and_send_to_admin',
    }),
    'INVALID_TRANSITION',
  );
  const sentByHr = await hrDirectApproval.service.applyTransition({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    action: 'verify_and_send_to_admin',
  });
  assert.strictEqual(sentByHr.offer.currentStatus, 'Admin Review');
  assert.strictEqual(sentByHr.offer.currentAssigneeRole, 'Admin');
  assert.strictEqual(hrDirectApproval.state.histories[0].action, 'verify_and_send_to_admin');
  assert.strictEqual(hrDirectApproval.state.histories[0].actorRole, 'HR');
  assert.strictEqual(hrDirectApproval.state.histories[0].previousStatus, 'TL Review');
  assert.strictEqual(hrDirectApproval.state.histories[0].newStatus, 'Admin Review');
  assert.strictEqual(hrDirectApproval.state.notifications.length, 1);
  assert.strictEqual(hrDirectApproval.state.notifications[0].recipientUserId, ADMIN);

  const tlAfterSubmit = createHarness({ candidate: eligibleCandidate() });
  tlAfterSubmit.state.offers.push(completeReviewOffer('HR Review', 'HR'));
  await expectError(
    () => tlAfterSubmit.service.saveDraft({
      tokenUser: actor(TL, 'TeamLead'),
      offerId: 'offer-tl',
      payload: { employment: { proposedDesignation: 'Corrected Developer' } },
    }),
    'OFFER_FORBIDDEN',
  );
  assert.strictEqual(tlAfterSubmit.state.offers[0].employment.proposedDesignation, 'Developer');
  const tlReturnedEdit = createHarness({ candidate: eligibleCandidate() });
  tlReturnedEdit.state.offers.push(completeReviewOffer('Returned to TL', 'TeamLead'));
  const tlCorrected = await tlReturnedEdit.service.saveDraft({
    tokenUser: actor(TL, 'TeamLead'),
    offerId: 'offer-tl',
    payload: { employment: { proposedDesignation: 'Corrected Developer' } },
  });
  assert.strictEqual(tlCorrected.offer.currentStatus, 'Returned to TL');
  assert.strictEqual(tlCorrected.offer.currentAssigneeRole, 'TeamLead');
  assert.strictEqual(tlCorrected.offer.employment.proposedDesignation, 'Corrected Developer');
  assert.strictEqual(tlReturnedEdit.state.histories.length, 0);
  const hrTooEarly = createHarness({ candidate: eligibleCandidate() });
  hrTooEarly.state.offers.push(completeReviewOffer('Initiated', 'TeamLead'));
  const hrSavedInitiated = await hrTooEarly.service.saveDraft({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    payload: { employment: { proposedDesignation: 'Too early' } },
  });
  assert.strictEqual(hrSavedInitiated.offer.currentStatus, 'Initiated');
  assert.strictEqual(hrSavedInitiated.offer.employment.proposedDesignation, 'Too early');

  const hrEdit = createHarness({ candidate: eligibleCandidate() });
  hrEdit.state.offers.push(completeReviewOffer('HR Review', 'HR'));
  const hrSaved = await hrEdit.service.saveDraft({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    payload: {
      employment: { proposedDesignation: 'Senior Developer', monthlyCtc: 480000 },
      commercial: { monthlyCtcCost: 1, monthlyMargin: 1, marginPercentage: 1, monthlyTotalCost: 1 },
    },
  });
  assert.strictEqual(hrSaved.offer._id, 'offer-tl');
  assert.strictEqual(hrSaved.offer.offerRequestNumber, 'ORR-2026-0007');
  assert.strictEqual(hrSaved.offer.currentStatus, 'HR Review');
  assert.strictEqual(hrSaved.offer.employment.proposedDesignation, 'Senior Developer');
  assert.strictEqual(hrSaved.offer.employment.agreedAnnualCtc, 600000);
  assert.strictEqual(hrSaved.offer.employment.monthlyCtc, 480000);
  assert.strictEqual(hrSaved.offer.commercial.monthlyCtcCost, 40000);
  assert.strictEqual(hrSaved.offer.commercial.monthlyBillingRate, 100000);
  assert.strictEqual(hrSaved.offer.commercial.monthlyTotalCost, 40000);
  assert.strictEqual(hrSaved.offer.commercial.monthlyMargin, 60000);
  assert.strictEqual(hrSaved.offer.commercial.employerPfEsiCost, 6000);
  assert.strictEqual(hrSaved.offer.hrRemarks, 'Check PAN');
  assert.ok(hrSaved.offer.documents.some((document) => document.documentType === 'resume' && document.originalFilename === 'resume.pdf'));
  assert.ok(hrEdit.state.offers[0].documents.some((document) => document.storageKey === 'offer-resume.pdf'));
  const beforeDelete = hrEdit.state.offers[0].documents.length;
  const removed = await hrEdit.service.removeDocument({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    documentId: 'doc-1',
  });
  assert.strictEqual(removed.offer.documents.length, beforeDelete - 1);
  assert.ok(!removed.offer.documents.some((document) => String(document._id) === 'doc-1'));
  assert.ok(hrEdit.state.histories.some((entry) => entry.action === 'delete_document'));
  await expectError(
    () => hrEdit.service.removeDocument({
      tokenUser: actor(TL, 'TeamLead'),
      offerId: 'offer-tl',
      documentId: 'doc-2',
    }),
    'OFFER_FORBIDDEN',
  );
  assert.strictEqual(hrEdit.state.histories.length, 1);
  assert.strictEqual(hrEdit.state.offers.length, 1);
  const incompleteHrSave = await hrEdit.service.saveDraft({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    payload: { candidate: { firstName: '' } },
  });
  assert.strictEqual(incompleteHrSave.offer.candidateSnapshot.firstName, '');

  const hrLater = createHarness({ candidate: eligibleCandidate() });
  hrLater.state.offers.push(completeReviewOffer('Offer Released', 'HR'));
  await expectError(
    () => hrLater.service.saveDraft({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      payload: { employment: { proposedDesignation: 'Released correction' } },
    }),
    'OFFER_FORBIDDEN',
  );
  hrLater.state.offers[0].currentStatus = 'Admin Review';
  hrLater.state.offers[0].currentAssigneeRole = 'Admin';
  await expectError(
    () => hrLater.service.saveDraft({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      payload: { employment: { proposedDesignation: 'Forwarded correction' } },
    }),
    'OFFER_FORBIDDEN',
  );

  const letterEdit = createHarness({ candidate: eligibleCandidate() });
  letterEdit.state.offers.push(completeReviewOffer('Letter Preparation Requested', 'HR'));
  const letterSaved = await letterEdit.service.saveDraft({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    payload: { employment: { proposedDesignation: 'Consultant' } },
  });
  assert.strictEqual(letterSaved.offer._id, 'offer-tl');
  assert.strictEqual(letterSaved.offer.currentStatus, 'Letter Preparation Requested');
  assert.strictEqual(letterSaved.offer.employment.proposedDesignation, 'Consultant');
  assert.strictEqual(letterEdit.state.histories.length, 0);
  letterEdit.state.offers[0].currentStatus = 'Letter Generated';
  letterEdit.state.offers[0].currentAssigneeRole = 'Admin';
  const generatedSaved = await letterEdit.service.saveDraft({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    payload: { employment: { proposedDesignation: 'Generated correction' } },
  });
  assert.strictEqual(generatedSaved.offer.currentStatus, 'Letter Generated');
  assert.strictEqual(generatedSaved.offer.employment.proposedDesignation, 'Generated correction');
  assert.strictEqual(letterEdit.state.histories.length, 0);

  const mdEdit = createHarness({ candidate: eligibleCandidate() });
  mdEdit.state.offers.push(completeReviewOffer('MD Review', 'MD'));
  await expectError(
    () => mdEdit.service.saveDraft({
      tokenUser: actor(MD, 'MD'),
      offerId: 'offer-tl',
      payload: { employment: { proposedJoiningDate: '2026-12-01' } },
    }),
    'OFFER_FORBIDDEN',
  );

  const adminEdit = createHarness({ candidate: eligibleCandidate() });
  adminEdit.state.offers.push(completeReviewOffer('Admin Review', 'Admin'));
  const adminSaved = await adminEdit.service.saveDraft({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    payload: { employment: { workLocation: 'Bengaluru' } },
  });
  assert.strictEqual(adminSaved.offer.currentStatus, 'Admin Review');
  assert.strictEqual(adminSaved.offer.employment.workLocation, 'Bengaluru');
  assert.strictEqual(adminSaved.offer._id, 'offer-tl');
  assert.strictEqual(adminEdit.state.histories.length, 0);
  adminEdit.state.offers[0].currentStatus = 'HR Review';
  const adminHrSaved = await adminEdit.service.saveDraft({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    payload: { employment: { workLocation: 'Pune' } },
  });
  assert.strictEqual(adminHrSaved.offer.currentStatus, 'HR Review');
  assert.strictEqual(adminHrSaved.offer.employment.workLocation, 'Pune');
  assert.strictEqual(adminEdit.state.histories.length, 0);
  adminEdit.state.offers[0].currentStatus = 'TL Review';
  const adminTlSaved = await adminEdit.service.saveDraft({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    payload: { employment: { proposedDesignation: 'Analyst' } },
  });
  assert.strictEqual(adminTlSaved.offer.currentStatus, 'TL Review');
  assert.strictEqual(adminTlSaved.offer.employment.proposedDesignation, 'Analyst');
  assert.strictEqual(adminEdit.state.histories.length, 0);
  await expectError(
    () => hrView.service.resolveDownload({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      documentId: 'doc-1',
    }),
    'DOCUMENT_NOT_FOUND',
  );
  assert.strictEqual(hrView.state.fileReads || 0, 0);

  const reviewOffer = completeReviewOffer('HR Review', 'HR');
  const returned = createHarness({ candidate: eligibleCandidate() });
  returned.state.offers.push(JSON.parse(JSON.stringify(reviewOffer)));
  await expectError(
    () => returned.service.applyTransition({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      action: 'return_to_tl',
      comments: 'PAN is missing',
    }),
    'OFFER_FORBIDDEN',
  );
  assert.strictEqual(returned.state.updates, 0);
  assert.strictEqual(returned.state.offers[0].currentStatus, 'HR Review');

  const sentToAdmin = await returned.service.applyTransition({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    action: 'verify_and_send_to_admin',
    hrRemarks: 'Verified',
  });
  assert.strictEqual(sentToAdmin.offer.currentStatus, 'Admin Review');
  assert.strictEqual(sentToAdmin.offer.currentAssigneeRole, 'Admin');
  assert.strictEqual(sentToAdmin.offer.hrRemarks, 'Verified');
  assert.strictEqual(returned.state.offers[0].currentAssigneeRole, 'Admin');

  const skip = resolveTransition({
    actor: actor(HR, 'HR'),
    offer: { ...reviewOffer, responsibleTeamLeadUserId: TL },
    action: 'approve',
  });
  assert.strictEqual(skip.code, 'INVALID_TRANSITION');

  const letterOffer = JSON.parse(JSON.stringify(tlOffer));
  letterOffer.currentStatus = 'Letter Preparation Requested';
  letterOffer.currentAssigneeRole = 'HR';
  const letterRun = createHarness({ candidate: eligibleCandidate() });
  letterRun.state.offers.push(letterOffer);
  letterOffer.candidateSnapshot.currentAddress = '12 MG Road';
  letterOffer.candidateSnapshot.permanentAddress = '12 MG Road';
  letterOffer.employment = {
    employmentCategory: 'Fresher',
    proposedDesignation: 'Developer',
    classification: 'Billable',
    workLocation: 'Hyderabad',
    workMode: 'Hybrid',
    contractType: 'C2H',
    reportingManager: 'Meera',
    responsibilities: 'Build features',
    proposedJoiningDate: '2026-11-01T00:00:00.000Z',
    monthlyCtc: 600000,
  };
  letterOffer.client = { clientName: 'Ada Clients' };
  letterOffer.commercial = {
    monthlyBillingRate: 100000,
    monthlyCtcCost: 50000,
    employerPfEsiCost: 0,
    otherApprovedMonthlyCosts: 0,
  };
  letterOffer.documents = completeRequiredDocuments('Fresher');
  const generated = await letterRun.service.applyTransition({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    action: 'generate_letter',
  });
  assert.strictEqual(generated.offer.currentStatus, 'Letter Generated');
  assert.strictEqual(generated.offer.currentAssigneeRole, 'HR');
  assert.strictEqual(generated.message, 'Offer step recorded as letter generated. No offer letter file is created or stored.');
  assert.strictEqual(generated.offer.letter?.storageKey || '', '');
  assert.strictEqual(letterRun.state.updates, 1);
  assert.strictEqual(letterRun.state.histories[0].previousStatus, 'Letter Preparation Requested');
  assert.strictEqual(letterRun.state.histories[0].newStatus, 'Letter Generated');
  assert.strictEqual(letterRun.state.offers[0].documents[0].verificationStatus, 'Verified');
  await expectError(
    () => letterRun.service.applyTransition({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      action: 'generate_letter',
    }),
    'INVALID_TRANSITION',
  );
  const earlyLetter = createHarness({ candidate: eligibleCandidate() });
  const earlyOffer = JSON.parse(JSON.stringify(tlOffer));
  earlyOffer.currentStatus = 'HR Review';
  earlyOffer.currentAssigneeRole = 'HR';
  earlyLetter.state.offers.push(earlyOffer);
  await expectError(
    () => earlyLetter.service.applyTransition({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      action: 'generate_letter',
    }),
    'INVALID_TRANSITION',
  );
  assert.strictEqual(earlyLetter.state.updates, 0);

  const verified = createHarness({ candidate: eligibleCandidate() });
  const readyForLetter = completeReviewOffer('MD Approved', 'Admin');
  verified.state.offers.push(readyForLetter);
  const handedOver = await verified.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'request_letter_preparation',
  });
  assert.strictEqual(handedOver.offer._id, 'offer-tl');
  assert.strictEqual(handedOver.offer.offerRequestNumber, 'ORR-2026-0007');
  assert.strictEqual(handedOver.offer.currentStatus, 'Letter Preparation Requested');
  assert.strictEqual(handedOver.offer.currentAssigneeRole, 'HR');
  assert.strictEqual(handedOver.message, 'Sent to HR to prepare the offer letter.');
  assert.strictEqual(handedOver.offer.letterPreparationSource, 'admin');
  assert.strictEqual(handedOver.offer.letterPreparationSubmittedByRole, 'Admin');
  assert.strictEqual(verified.state.histories.length, 1);
  assert.strictEqual(verified.state.histories[0].action, 'request_letter_preparation');
  assert.strictEqual(verified.state.histories[0].previousStatus, 'MD Approved');
  assert.strictEqual(verified.state.histories[0].newStatus, 'Letter Preparation Requested');
  assert.strictEqual(verified.state.histories[0].actorUserId, ADMIN);
  assert.strictEqual(verified.state.histories[0].actorRole, 'Admin');
  assert.strictEqual(verified.state.notifications.length, 1);
  assert.strictEqual(verified.state.notifications[0].recipientUserId, HR);
  assert.strictEqual(
    verified.state.notifications[0].message,
    'ORR-2026-0007 for Asha Rao at Ada Clients: Admin instructed HR to generate the offer.',
  );
  assert.strictEqual(verified.state.notifications[0].link, '/offers/offer-tl');
  assert.ok(verified.state.offers[0].documents.some((document) => document.storageKey));
  const alreadyPending = await verified.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'request_letter_preparation',
  });
  assert.strictEqual(alreadyPending.offer.currentStatus, 'Letter Preparation Requested');
  assert.strictEqual(alreadyPending.message, 'This request is already with HR for offer generation.');
  assert.strictEqual(verified.state.notifications.length, 1);
  assert.strictEqual(verified.state.histories.length, 1);
  const resent = await verified.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'resend_hr_generation_notice',
  });
  assert.strictEqual(resent.message, 'HR notification resent for offer generation.');
  assert.strictEqual(verified.state.notifications.length, 2);
  assert.strictEqual(verified.state.histories[1].action, 'resend_hr_generation_notice');
  assert.strictEqual(verified.state.histories[1].previousStatus, 'Letter Preparation Requested');
  assert.strictEqual(verified.state.histories[1].newStatus, 'Letter Preparation Requested');

  const adminDirect = createHarness({ candidate: eligibleCandidate() });
  const adminReady = completeReviewOffer('MD Review', 'MD');
  adminDirect.state.offers.push(adminReady);
  const routed = await adminDirect.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'request_letter_preparation',
  });
  assert.strictEqual(routed.offer.currentStatus, 'Letter Preparation Requested');
  assert.strictEqual(routed.offer.currentAssigneeRole, 'HR');
  assert.strictEqual(routed.offer.letterPreparationSource, 'admin');
  assert.strictEqual(routed.message, 'Sent to HR to prepare the offer letter.');
  assert.strictEqual(adminDirect.state.notifications.length, 1);
  assert.strictEqual(adminDirect.state.notifications[0].recipientUserId, HR);
  assert.strictEqual(
    adminDirect.state.notifications[0].message,
    'ORR-2026-0007 for Asha Rao at Ada Clients: Admin instructed HR to generate the offer.',
  );
  assert.strictEqual(adminDirect.state.histories[0].previousStatus, 'MD Review');
  await expectError(
    () => adminDirect.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'generate_letter',
    }),
    'OFFER_FORBIDDEN',
  );
  const generatedByHr = await adminDirect.service.applyTransition({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    action: 'generate_letter',
  });
  assert.strictEqual(generatedByHr.offer.currentStatus, 'Letter Generated');
  assert.strictEqual(adminDirect.state.offers[0].letterPreparationSource, 'admin');
  assert.strictEqual(verified.state.histories.length, 2);
  assert.strictEqual(verified.state.notifications.length, 2);
  assert.strictEqual(verified.state.offers[0].currentStatus, 'Letter Preparation Requested');

  const alreadyReviewing = createHarness({ candidate: eligibleCandidate() });
  const reviewingOffer = completeReviewOffer('Admin Review', 'Admin');
  alreadyReviewing.state.offers.push(reviewingOffer);
  const fromReview = await alreadyReviewing.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'request_letter_preparation',
  });
  assert.strictEqual(fromReview.offer.currentStatus, 'Letter Preparation Requested');
  assert.strictEqual(fromReview.offer.currentAssigneeRole, 'HR');

  const incomplete = JSON.parse(JSON.stringify(tlOffer));
  incomplete.currentStatus = 'MD Approved';
  incomplete.currentAssigneeRole = 'Admin';
  const rejected = createHarness({ candidate: eligibleCandidate() });
  rejected.state.offers.push(incomplete);
  const rejectedError = await expectError(
    () => rejected.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'request_letter_preparation',
    }),
    'OFFER_GENERATION_VALIDATION_FAILED',
  );
  assert.ok(Array.isArray(rejectedError.details?.missingFields));
  assert.ok(rejectedError.details.missingFields.length > 0);
  assert.deepStrictEqual(rejectedError.details?.missingDocuments, []);
  assert.ok(rejectedError.details.sections.find((section) => section.id === 'documents' && section.optional));
  assert.strictEqual(rejected.state.updates, 0);
  assert.strictEqual(rejected.state.offers[0].currentStatus, 'MD Approved');
  await expectError(
    () => rejected.service.applyTransition({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      action: 'request_letter_preparation',
    }),
    'OFFER_FORBIDDEN',
  );

  const blockedApprove = createHarness({ candidate: eligibleCandidate() });
  const incompleteMd = JSON.parse(JSON.stringify(tlOffer));
  incompleteMd.currentStatus = 'Admin Review';
  incompleteMd.currentAssigneeRole = 'Admin';
  blockedApprove.state.offers.push(incompleteMd);
  await expectError(
    () => blockedApprove.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'approve_and_send_for_release',
    }),
    'OFFER_GENERATION_VALIDATION_FAILED',
  );
  assert.strictEqual(blockedApprove.state.updates, 0);
  assert.strictEqual(blockedApprove.state.offers[0].currentStatus, 'Admin Review');
  assert.strictEqual(blockedApprove.state.notifications.length, 0);

  const conflict = createHarness({ candidate: eligibleCandidate(), staleRead: true });
  const live = completeReviewOffer('Admin Review', 'Admin');
  live.workflowVersion = 4;
  conflict.state.offers.push(live);
  const originalAdminReview = JSON.parse(JSON.stringify(live));
  const first = await conflict.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'approve_and_send_for_release',
  });
  assert.strictEqual(first.offer.currentStatus, 'Letter Preparation Requested');
  assert.strictEqual(first.offer.currentAssigneeRole, 'HR');
  assert.strictEqual(first.offer.letterPreparationSource, 'admin');
  assert.strictEqual(first.offer.letterPreparationSubmittedByRole, 'Admin');
  assert.strictEqual(conflict.state.notifications.length, 1);
  assert.strictEqual(conflict.state.notifications[0].recipientUserId, HR);
  conflict.state.stale = originalAdminReview;
  await expectError(
    () => conflict.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'approve_and_send_for_release',
    }),
    'OFFER_CONFLICT',
  );
  assert.strictEqual(conflict.state.offers[0].currentStatus, 'Letter Preparation Requested');
  assert.strictEqual(conflict.state.histories.length, 1);

  const directGeneration = createHarness({ candidate: eligibleCandidate() });
  const initiatedOffer = completeReviewOffer('Initiated', 'TeamLead');
  initiatedOffer.documents = [];
  initiatedOffer.responsibleHrUserId = HR;
  initiatedOffer.responsibleHrName = 'Hema';
  directGeneration.state.offers.push(initiatedOffer);
  const savedBeforeGenerate = await directGeneration.service.saveDraft({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    payload: { employment: { proposedDesignation: 'Senior Developer' } },
  });
  assert.strictEqual(savedBeforeGenerate.offer.currentStatus, 'Initiated');
  assert.strictEqual(savedBeforeGenerate.offer.employment.proposedDesignation, 'Senior Developer');
  const generatedEarly = await directGeneration.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'approve_and_send_for_release',
  });
  assert.strictEqual(generatedEarly.offer.currentStatus, 'Letter Preparation Requested');
  assert.strictEqual(generatedEarly.offer.currentAssigneeRole, 'HR');
  assert.strictEqual(generatedEarly.offer.currentAssigneeUserId, HR);
  assert.strictEqual(generatedEarly.offer.employment.proposedDesignation, 'Senior Developer');
  assert.strictEqual(generatedEarly.offer.letterPreparationSource, 'admin');
  assert.strictEqual(generatedEarly.offer.adminApprovedByUserId, ADMIN);
  const generationHistory = directGeneration.state.histories[directGeneration.state.histories.length - 1];
  assert.strictEqual(generationHistory.action, 'approve_and_send_for_release');
  assert.strictEqual(generationHistory.previousStatus, 'Initiated');
  assert.strictEqual(generationHistory.newStatus, 'Letter Preparation Requested');
  assert.strictEqual(directGeneration.state.notifications.length, 1);
  assert.strictEqual(directGeneration.state.notifications[0].recipientUserId, HR);
  const duplicateGeneration = await directGeneration.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'approve_and_send_for_release',
  });
  assert.strictEqual(duplicateGeneration.message, 'This request is already with HR for offer generation.');
  assert.strictEqual(directGeneration.state.offers[0].currentStatus, 'Letter Preparation Requested');
  assert.strictEqual(directGeneration.state.notifications.length, 1);
  assert.strictEqual(directGeneration.state.histories.filter((entry) => entry.action === 'approve_and_send_for_release').length, 1);
  await expectError(
    () => directGeneration.service.applyTransition({
      tokenUser: actor(TL, 'TeamLead'),
      offerId: 'offer-tl',
      action: 'approve_and_send_for_release',
    }),
    'OFFER_FORBIDDEN',
  );
  const hrStage = createHarness({ candidate: eligibleCandidate() });
  const hrOwned = completeReviewOffer('HR Review', 'HR');
  hrOwned.documents = [];
  hrStage.state.offers.push(hrOwned);
  await expectError(
    () => hrStage.service.applyTransition({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      action: 'approve_and_send_for_release',
    }),
    'OFFER_FORBIDDEN',
  );
  const fromHrReview = await hrStage.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'approve_and_send_for_release',
  });
  assert.strictEqual(fromHrReview.offer.currentStatus, 'Letter Preparation Requested');
  assert.strictEqual(fromHrReview.offer.documents.length, 0);
  assert.strictEqual(hrStage.state.notifications.length, 1);

  const releaseRun = createHarness({ candidate: eligibleCandidate() });
  const readyToRelease = completeReviewOffer('Letter Preparation Requested', 'HR');
  readyToRelease.initiatedByUserId = ADMIN;
  readyToRelease.initiatedByRole = 'Admin';
  readyToRelease.adminApprovedByUserId = ADMIN;
  readyToRelease.letterPreparationSubmittedByUserId = ADMIN;
  readyToRelease.letterPreparationSubmittedByRole = 'Admin';
  releaseRun.state.offers.push(readyToRelease);
  const released = await releaseRun.service.applyTransition({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    action: 'release_offer',
  });
  assert.strictEqual(released.offer.currentStatus, 'Offer Released');
  assert.strictEqual(releaseRun.candidate.Status[0].Status, 'Joined');
  assert.strictEqual(releaseRun.candidate.Status[1].Status, 'Offer to be released');
  assert.strictEqual(releaseRun.candidate.Status[releaseRun.candidate.Status.length - 1].Status, 'Offer Released');
  assert.strictEqual(releaseRun.state.candidateStatusWrites, 1);
  assert.ok(released.offer.releasedAt);
  assert.strictEqual(released.offer.releasedByUserId, HR);
  assert.strictEqual(releaseRun.state.notifications.length, 1);
  assert.strictEqual(releaseRun.state.notifications[0].recipientUserId, ADMIN);
  assert.strictEqual(
    releaseRun.state.notifications[0].message,
    'Offer released successfully for Asha Rao – ORR-2026-0007.',
  );
  assert.strictEqual(releaseRun.state.notifications[0].link, '/offers/offer-tl');
  assert.ok(!releaseRun.state.notifications.some((item) => item.recipientUserId === TL));
  await expectError(
    () => releaseRun.service.applyTransition({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      action: 'release_offer',
    }),
    'INVALID_TRANSITION',
  );
  assert.strictEqual(releaseRun.state.offers[0].currentStatus, 'Offer Released');
  assert.strictEqual(releaseRun.state.notifications.length, 1);
  assert.strictEqual(releaseRun.state.candidateStatusWrites, 1);
  assert.strictEqual(releaseRun.state.histories.filter((entry) => entry.action === 'release_offer').length, 1);
  await expectError(
    () => releaseRun.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'release_offer',
    }),
    'INVALID_TRANSITION',
  );
  assert.strictEqual(releaseRun.state.candidateStatusWrites, 1);

  const adminLetterRelease = createHarness({ candidate: eligibleCandidate() });
  const adminLetterReady = completeReviewOffer('Letter Preparation Requested', 'HR');
  adminLetterRelease.state.offers.push(adminLetterReady);
  const releasedByAdmin = await adminLetterRelease.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'release_offer',
  });
  assert.strictEqual(releasedByAdmin.offer.currentStatus, 'Offer Released');
  assert.strictEqual(releasedByAdmin.offer.releasedByUserId, ADMIN);
  assert.ok(releasedByAdmin.offer.releasedAt);
  assert.strictEqual(adminLetterRelease.candidate.Status[adminLetterRelease.candidate.Status.length - 1].Status, 'Offer Released');
  assert.strictEqual(adminLetterRelease.state.candidateStatusWrites, 1);
  assert.strictEqual(adminLetterRelease.state.histories.filter((entry) => entry.action === 'release_offer').length, 1);
  await expectError(
    () => adminLetterRelease.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'release_offer',
    }),
    'INVALID_TRANSITION',
  );
  assert.strictEqual(adminLetterRelease.state.candidateStatusWrites, 1);
  assert.strictEqual(adminLetterRelease.candidate.Status.filter((entry) => entry.Status === 'Offer Released').length, 1);
  await expectError(
    () => adminLetterRelease.service.applyTransition({
      tokenUser: actor(TL, 'TeamLead'),
      offerId: 'offer-tl',
      action: 'release_offer',
    }),
    'OFFER_FORBIDDEN',
  );

  async function syncFrom(status, assigneeRole, action, tokenUser, comments) {
    const run = createHarness({ candidate: eligibleCandidate() });
    const offer = completeReviewOffer(status, assigneeRole);
    offer.responsibleTeamLeadUserId = TL;
    if (tokenUser.role === 'TeamLead') {
      offer.currentAssigneeRole = 'TeamLead';
      offer.currentAssigneeUserId = tokenUser.id;
      offer.responsibleTeamLeadUserId = tokenUser.id;
    }
    run.state.offers.push(offer);
    const before = run.candidate.Status.map((entry) => entry.Status);
    const result = await run.service.applyTransition({
      tokenUser,
      offerId: 'offer-tl',
      action,
      comments,
    });
    return { run, result, before };
  }

  const acceptedByAdmin = await syncFrom('Offer Released', 'HR', 'mark_accepted', actor(ADMIN, 'Admin'));
  assert.strictEqual(acceptedByAdmin.result.offer.currentStatus, 'Offer Accepted');
  assert.strictEqual(acceptedByAdmin.run.candidate.Status[acceptedByAdmin.run.candidate.Status.length - 1].Status, 'Offer Accepted');
  assert.deepStrictEqual(acceptedByAdmin.before, ['Joined', 'Offer to be released']);
  assert.strictEqual(acceptedByAdmin.run.state.histories.filter((entry) => entry.action === 'mark_accepted').length, 1);
  await expectError(
    () => acceptedByAdmin.run.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'mark_accepted',
    }),
    'INVALID_TRANSITION',
  );
  assert.strictEqual(acceptedByAdmin.run.state.candidateStatusWrites, 1);
  assert.deepStrictEqual(acceptedByAdmin.run.state.notifications.map((item) => item.recipientUserId), [HR]);

  const acceptedByHr = await syncFrom('Offer Released', 'HR', 'mark_accepted', actor(HR, 'HR'));
  assert.strictEqual(acceptedByHr.run.candidate.Status[acceptedByHr.run.candidate.Status.length - 1].Status, 'Offer Accepted');
  assert.deepStrictEqual(acceptedByHr.run.state.notifications.map((item) => item.recipientUserId), [ADMIN]);
  const acceptedByTl = await syncFrom('Offer Released', 'HR', 'mark_accepted', actor(TL, 'TeamLead'));
  assert.strictEqual(acceptedByTl.run.candidate.Status[acceptedByTl.run.candidate.Status.length - 1].Status, 'Offer Accepted');
  const otherTl = createHarness({ candidate: eligibleCandidate() });
  const otherTlOffer = completeReviewOffer('Offer Released', 'HR');
  otherTlOffer.responsibleTeamLeadUserId = TL;
  otherTl.state.offers.push(otherTlOffer);
  await expectError(
    () => otherTl.service.applyTransition({
      tokenUser: actor(TL_TWO, 'TeamLead'),
      offerId: 'offer-tl',
      action: 'mark_accepted',
    }),
    'OFFER_FORBIDDEN',
  );
  assert.strictEqual(otherTl.candidate.Status[otherTl.candidate.Status.length - 1].Status, 'Offer to be released');

  const alreadyAccepted = createHarness({
    candidate: baseCandidate([
      { Status: 'Offer to be released', Date: '2026-03-01T00:00:00.000Z' },
      { Status: 'Offer Accepted', Date: '2026-04-01T00:00:00.000Z', Remark: 'Accepted from follow-up' },
    ]),
  });
  alreadyAccepted.state.offers.push(completeReviewOffer('Offer Released', 'HR'));
  await alreadyAccepted.service.applyTransition({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    action: 'mark_accepted',
  });
  assert.deepStrictEqual(
    alreadyAccepted.candidate.Status.map((entry) => entry.Status),
    ['Offer to be released', 'Offer Accepted'],
  );
  assert.strictEqual(alreadyAccepted.candidate.Status[1].Remark, 'Accepted from follow-up');
  assert.strictEqual(alreadyAccepted.state.candidateStatusWrites || 0, 0);

  const declinedMissing = createHarness({ candidate: eligibleCandidate() });
  declinedMissing.state.offers.push(completeReviewOffer('Offer Accepted', 'Admin'));
  await expectError(
    () => declinedMissing.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'mark_declined',
    }),
    'COMMENTS_REQUIRED',
  );
  assert.strictEqual(declinedMissing.state.offers[0].currentStatus, 'Offer Accepted');
  assert.strictEqual(declinedMissing.state.histories.length, 0);
  assert.strictEqual(declinedMissing.candidate.Status[declinedMissing.candidate.Status.length - 1].Status, 'Offer to be released');

  const declined = await syncFrom(
    'Offer Accepted',
    'Admin',
    'mark_declined',
    actor(HR, 'HR'),
    'Candidate accepted another offer',
  );
  assert.strictEqual(declined.result.offer.currentStatus, 'Candidate Declined');
  assert.strictEqual(declined.run.candidate.Status[declined.run.candidate.Status.length - 1].Status, 'Candidate Declined');
  assert.strictEqual(declined.run.candidate.Status[declined.run.candidate.Status.length - 1].Remark, 'Candidate accepted another offer');
  assert.strictEqual(declined.run.candidate.rejectionStage, 'Offer Declined');
  assert.strictEqual(declined.run.candidate.rejectionReason, 'Candidate accepted another offer');
  assert.strictEqual(declined.run.candidate.rejectedBy, HR);
  assert.strictEqual(declined.before[0], 'Joined');

  const onboard = await syncFrom('Offer Accepted', 'HR', 'confirm_onboard', actor(TL, 'TeamLead'));
  assert.strictEqual(onboard.result.offer.currentStatus, 'Onboard Confirmation');
  assert.strictEqual(onboard.run.candidate.Status[onboard.run.candidate.Status.length - 1].Status, 'Onboard Confirmation');
  assert.deepStrictEqual(onboard.run.state.notifications.map((item) => item.recipientUserId).sort(), [ADMIN, HR].sort());
  const joined = await syncFrom('Onboard Confirmation', 'TeamLead', 'mark_joined', actor(ADMIN, 'Admin'));
  assert.strictEqual(joined.result.offer.currentStatus, 'Joined');
  assert.strictEqual(joined.run.candidate.Status[joined.run.candidate.Status.length - 1].Status, 'Joined');
  assert.deepStrictEqual(joined.run.state.notifications.map((item) => item.recipientUserId), [HR]);
  await expectError(
    () => joined.run.service.initiateOffer({
      tokenUser: actor(ADMIN, 'Admin'),
      candidateSubdocumentId: SUB,
      recipientUserId: TL,
    }),
    'CANDIDATE_NOT_ELIGIBLE',
  );

  const ahead = createHarness({
    candidate: baseCandidate([{ Status: 'Joined', Date: '2026-05-01T00:00:00.000Z' }]),
  });
  ahead.state.offers.push(completeReviewOffer('Offer Accepted', 'HR'));
  await ahead.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'confirm_onboard',
  });
  assert.deepStrictEqual(ahead.candidate.Status.map((entry) => entry.Status), ['Joined']);
  assert.strictEqual(ahead.state.offers[0].currentStatus, 'Onboard Confirmation');

  const syncFailure = createHarness({ candidate: eligibleCandidate() });
  syncFailure.state.failCandidateSyncTimes = 3;
  syncFailure.state.offers.push(completeReviewOffer('Letter Preparation Requested', 'HR'));
  await expectError(
    () => syncFailure.service.applyTransition({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      action: 'release_offer',
    }),
    'CANDIDATE_STATUS_SYNC_FAILED',
  );
  assert.strictEqual(syncFailure.state.offers[0].currentStatus, 'Offer Released');
  assert.strictEqual(syncFailure.state.histories.filter((entry) => entry.action === 'release_offer').length, 1);
  assert.strictEqual(syncFailure.candidate.Status[syncFailure.candidate.Status.length - 1].Status, 'Offer to be released');
  syncFailure.state.failCandidateSyncTimes = 2;
  const healed = await syncFailure.service.applyTransition({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    action: 'release_offer',
  });
  assert.strictEqual(healed.message, 'Candidate application status synchronized.');
  assert.strictEqual(syncFailure.candidate.Status[syncFailure.candidate.Status.length - 1].Status, 'Offer Released');
  assert.strictEqual(syncFailure.state.histories.filter((entry) => entry.action === 'release_offer').length, 1);

  const hrReview = createHarness({ candidate: eligibleCandidate() });
  hrReview.state.offers.push(completeReviewOffer('TL Review', 'TeamLead'));
  await hrReview.service.applyTransition({
    tokenUser: actor(TL, 'TeamLead'),
    offerId: 'offer-tl',
    action: 'submit_to_hr',
  });
  assert.strictEqual(hrReview.state.offers[0].currentStatus, 'HR Review');
  assert.strictEqual(hrReview.candidate.Status[hrReview.candidate.Status.length - 1].Status, 'Offer to be released');
  assert.strictEqual(hrReview.state.candidateStatusWrites || 0, 0);

  const missed = createHarness({ candidate: eligibleCandidate() });
  const missedOffer = completeReviewOffer('Offer Accepted', 'Admin');
  missedOffer.workflowVersion = 4;
  missed.state.offers.push(missedOffer);
  const missedView = await missed.service.getOffer({ tokenUser: actor(ADMIN, 'Admin'), offerId: 'offer-tl' });
  assert.strictEqual(missedView.offer.currentStatus, 'Offer Accepted');
  assert.strictEqual(missed.state.offers[0].workflowVersion, 4);
  assert.strictEqual(missed.state.histories.length, 0);
  assert.strictEqual(missed.candidate.Status[0].Status, 'Joined');
  assert.strictEqual(missed.candidate.Status[missed.candidate.Status.length - 1].Status, 'Offer Accepted');
  assert.strictEqual(missed.state.candidateStatusWrites, 1);
  await missed.service.listOffers({ tokenUser: actor(ADMIN, 'Admin'), query: {} });
  assert.strictEqual(missed.state.candidateStatusWrites, 1);
  assert.strictEqual(missed.candidate.Status.filter((entry) => entry.Status === 'Offer Accepted').length, 1);

  const pendingGeneration = createHarness({ candidate: eligibleCandidate() });
  pendingGeneration.state.offers.push(completeReviewOffer('Letter Preparation Requested', 'HR'));
  await expectError(
    () => pendingGeneration.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'generate_letter',
    }),
    'OFFER_FORBIDDEN',
  );
  const adminReleased = await pendingGeneration.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'release_offer',
  });
  assert.strictEqual(adminReleased.offer.currentStatus, 'Offer Released');
  assert.strictEqual(pendingGeneration.candidate.Status[pendingGeneration.candidate.Status.length - 1].Status, 'Offer Released');
  assert.strictEqual(pendingGeneration.state.histories.filter((entry) => entry.action === 'release_offer').length, 1);
  await expectError(
    () => pendingGeneration.service.applyTransition({
      tokenUser: actor(TL, 'TeamLead'),
      offerId: 'offer-tl',
      action: 'generate_letter',
    }),
    'OFFER_FORBIDDEN',
  );
  await expectError(
    () => pendingGeneration.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'return_to_md',
      comments: 'Please recheck the CTC',
    }),
    'OFFER_FORBIDDEN',
  );

  async function assertAdminReturn(target, assigneeRole, recipientId) {
    const run = createHarness({ candidate: eligibleCandidate() });
    run.state.offers.push(completeReviewOffer('MD Approved', 'Admin'));
    await expectError(
      () => run.service.applyTransition({
        tokenUser: actor(ADMIN, 'Admin'),
        offerId: 'offer-tl',
        action: 'admin_return',
        returnTarget: target,
        comments: '   ',
      }),
      'COMMENTS_REQUIRED',
    );
    const result = await run.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'admin_return',
      returnTarget: target,
      comments: `Please correct details for ${target}`,
    });
    assert.strictEqual(result.offer.currentStatus, 'Returned by Admin');
    assert.strictEqual(result.offer.currentAssigneeRole, assigneeRole);
    assert.strictEqual(result.offer.offerRequestNumber, 'ORR-2026-0007');
    assert.strictEqual(run.state.histories[0].action, `admin_return_to_${target}`);
    assert.strictEqual(run.state.histories[0].comments, `Please correct details for ${target}`);
    assert.strictEqual(run.state.histories[0].previousStatus, 'MD Approved');
    assert.strictEqual(run.state.histories[0].newStatus, 'Returned by Admin');
    assert.ok(run.state.notifications.some((item) => item.recipientUserId === recipientId));
    assert.ok(run.state.notifications[0].message.includes(`returned to`));
    assert.ok(run.state.notifications[0].message.includes(`Please correct details for ${target}`));
    return run;
  }

  const tlReturnBlocked = createHarness({ candidate: eligibleCandidate() });
  tlReturnBlocked.state.offers.push(completeReviewOffer('Admin Review', 'Admin'));
  await expectError(
    () => tlReturnBlocked.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'admin_return',
      returnTarget: 'tl',
      comments: 'Send this back to the team lead',
    }),
    'OFFER_FORBIDDEN',
  );
  assert.strictEqual(tlReturnBlocked.state.offers[0].currentStatus, 'Admin Review');
  assert.strictEqual(tlReturnBlocked.state.notifications.length, 0);
  await assertAdminReturn('hr', 'HR', HR);
  const namedHrReturn = createHarness({
    candidate: eligibleCandidate(),
    hrUsers: [{ id: HR }, { id: HR_TWO }],
  });
  const namedOffer = completeReviewOffer('Admin Review', 'Admin');
  namedOffer.responsibleHrUserId = HR_TWO;
  namedOffer.responsibleHrName = 'Nisha';
  namedHrReturn.state.offers.push(namedOffer);
  const namedResult = await namedHrReturn.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'admin_return',
    returnTarget: 'hr',
    comments: 'Correct the CTC',
  });
  assert.strictEqual(namedResult.offer.currentAssigneeUserId, HR_TWO);
  assert.deepStrictEqual(namedHrReturn.state.notifications.map((item) => item.recipientUserId), [HR_TWO]);
  const hrBackward = createHarness({ candidate: eligibleCandidate() });
  hrBackward.state.offers.push(completeReviewOffer('HR Review', 'HR'));
  await expectError(
    () => hrBackward.service.applyTransition({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      action: 'return_to_tl',
      comments: 'Send it back',
    }),
    'OFFER_FORBIDDEN',
  );
  const noMdReturn = createHarness({ candidate: eligibleCandidate() });
  noMdReturn.state.offers.push(completeReviewOffer('Admin Review', 'Admin'));
  await expectError(
    () => noMdReturn.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'admin_return',
      returnTarget: 'md',
      comments: 'no md',
    }),
    'OFFER_FORBIDDEN',
  );

  async function assertAdminReturnFromStatus(status, assigneeRole) {
    const run = createHarness({ candidate: eligibleCandidate() });
    const offer = completeReviewOffer(status, assigneeRole);
    run.state.offers.push(offer);
    const result = await run.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'admin_return',
      returnTarget: 'hr',
      comments: `Admin return from ${status}`,
    });
    assert.strictEqual(result.offer.currentStatus, 'Returned by Admin');
    assert.strictEqual(result.offer.currentAssigneeRole, 'HR');
    assert.strictEqual(run.state.histories[0].previousStatus, status);
    assert.strictEqual(run.state.histories[0].action, 'admin_return_to_hr');
    assert.ok(run.state.notifications.some((item) => item.recipientUserId === HR));
    assert.ok(!run.state.notifications.some((item) => item.recipientUserId === TL));
  }

  await assertAdminReturnFromStatus('Initiated', 'TeamLead');
  await assertAdminReturnFromStatus('TL Review', 'TeamLead');
  await assertAdminReturnFromStatus('HR Review', 'HR');
  await assertAdminReturnFromStatus('MD Review', 'MD');
  await assertAdminReturnFromStatus('Admin Review', 'Admin');
  await assertAdminReturnFromStatus('Letter Preparation Requested', 'HR');
  await assertAdminReturnFromStatus('Letter Generated', 'HR');

  const releasedBlock = createHarness({ candidate: eligibleCandidate() });
  releasedBlock.state.offers.push(completeReviewOffer('Offer Released', 'Admin'));
  await expectError(
    () => releasedBlock.service.applyTransition({
      tokenUser: actor(ADMIN, 'Admin'),
      offerId: 'offer-tl',
      action: 'admin_return',
      returnTarget: 'hr',
      comments: 'Too late to return',
    }),
    'INVALID_TRANSITION',
  );

  const unauthorizedReturn = createHarness({ candidate: eligibleCandidate() });
  unauthorizedReturn.state.offers.push(completeReviewOffer('TL Review', 'TeamLead'));
  await expectError(
    () => unauthorizedReturn.service.applyTransition({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      action: 'admin_return',
      returnTarget: 'tl',
      comments: 'HR cannot use admin return',
    }),
    'OFFER_FORBIDDEN',
  );

  const mdBlocked = createHarness({ candidate: eligibleCandidate() });
  mdBlocked.state.offers.push(completeReviewOffer('Admin Review', 'Admin'));
  await expectError(
    () => mdBlocked.service.applyTransition({
      tokenUser: actor(MD, 'MD'),
      offerId: 'offer-tl',
      action: 'return_to_hr',
      comments: 'Please verify the financial information',
    }),
    'OFFER_FORBIDDEN',
  );

  const cancelRun = createHarness({ candidate: eligibleCandidate() });
  cancelRun.state.offers.push(completeReviewOffer('Letter Preparation Requested', 'HR'));
  const cancelled = await cancelRun.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'cancel',
    comments: 'Candidate withdrew',
  });
  assert.strictEqual(cancelled.offer.currentStatus, 'Cancelled');
  assert.strictEqual(cancelled.offer.isOpen, false);
  assert.strictEqual(cancelRun.state.offers.length, 1);
  assert.strictEqual(cancelRun.state.histories.length, 1);
  assert.strictEqual(cancelRun.state.histories[0].action, 'cancel');
  assert.strictEqual(cancelRun.state.histories[0].previousStatus, 'Letter Preparation Requested');
  assert.strictEqual(cancelRun.state.notifications.length, 0);

  const fresher = {
    candidateSnapshot: {
      firstName: 'Asha', lastName: 'Rao', email: 'a@b.c', mobileNumber: '999',
      currentAddress: 'Line 1', permanentAddress: 'Line 2',
    },
    employment: {
      employmentCategory: 'Fresher',
      currentCompany: '',
      proposedDesignation: 'Engineer',
      classification: 'Administrative',
      workLocation: 'Hyderabad',
      workMode: 'Remote',
      contractType: 'Permanent',
      reportingManager: 'Meera',
      responsibilities: 'Delivery',
      proposedJoiningDate: '2026-11-01',
      agreedAnnualCtc: 600000,
      monthlyCtc: 50000,
    },
    client: { clientName: '' },
    commercial: { monthlyCtcCost: 50000, employerPfEsiCost: 0, otherApprovedMonthlyCosts: 0 },
    documents: ['aadhaar', 'pan', 'photograph', 'resume', 'education_certificate', 'address_proof'].map((documentType) => ({
      documentType,
      verificationStatus: 'Pending',
    })),
  };
  const fresherResult = validateOfferForSubmission(fresher, 'hr');
  assert.strictEqual(fresherResult.ok, true);
  const blankOffering = JSON.parse(JSON.stringify(fresher));
  blankOffering.employment.agreedAnnualCtc = null;
  assert.strictEqual(validateOfferForSubmission(blankOffering, 'hr').ok, true);
  assert.strictEqual(blankOffering.employment.monthlyCtc, 50000);
  const missingMonthly = JSON.parse(JSON.stringify(fresher));
  missingMonthly.employment.monthlyCtc = null;
  assert.ok(validateOfferForSubmission(missingMonthly, 'hr').errors.some((error) => error === 'Candidate Agreed Annual CTC is required'));
  assert.strictEqual(missingMonthly.employment.agreedAnnualCtc, 600000);
  assert.strictEqual(missingMonthly.commercial.monthlyCtcCost, 50000);
  assert.ok(!fresherResult.errors.some((error) => /education|qualification|employment type|offer type/i.test(error)));
  const withoutDocuments = { ...fresher, documents: [] };
  const withoutDocumentsResult = validateOfferForSubmission(withoutDocuments, 'hr');
  assert.strictEqual(withoutDocumentsResult.ok, true);
  assert.ok(!withoutDocumentsResult.errors.some((error) => error.includes('Upload the required document')));
  const missingContractType = JSON.parse(JSON.stringify(withoutDocuments));
  missingContractType.employment.contractType = '';
  assert.strictEqual(validateOfferForSubmission(missingContractType, 'hr').ok, true);
  assert.ok(!validateOfferForSubmission(missingContractType, 'admin').errors.some((error) => /Contract Type/i.test(error)));
  const missingManager = JSON.parse(JSON.stringify(withoutDocuments));
  missingManager.employment.reportingManager = '';
  missingManager.employment.responsibilities = '';
  const withoutRemovedFields = validateOfferForSubmission(missingManager, 'hr');
  assert.strictEqual(withoutRemovedFields.ok, true);
  assert.ok(!withoutRemovedFields.errors.some((error) => /Reporting manager|Responsibilities|Commercial remarks/i.test(error)));
  const experienced = JSON.parse(JSON.stringify(withoutDocuments));
  experienced.employment.employmentCategory = 'Experienced';
  experienced.employment.currentCompany = '';
  experienced.candidateSnapshot.currentCompany = '';
  const experiencedErrors = validateOfferForSubmission(experienced, 'hr').errors;
  assert.ok(experiencedErrors.some((error) => error.includes('Current company')));
  assert.ok(!experiencedErrors.some((error) => error.includes('experience_document')));
  experienced.employment.currentCompany = 'Ada';
  assert.ok(validateOfferForSubmission(experienced, 'hr').errors.some((error) => error.includes('Total experience')));
  experienced.employment.totalExperience = '4';
  experienced.employment.relevantExperience = '5';
  assert.ok(validateOfferForSubmission(experienced, 'hr').errors.some((error) => /cannot exceed total experience/i.test(error)));
  experienced.employment.relevantExperience = '3';
  assert.strictEqual(validateOfferForSubmission(experienced, 'hr').ok, true);
  const pendingDocument = JSON.parse(JSON.stringify(withoutDocuments));
  pendingDocument.documents = [{
    documentType: 'aadhaar',
    originalFilename: 'aadhaar.pdf',
    storageKey: 'offer-aadhaar.pdf',
    verificationStatus: 'Pending',
  }];
  assert.ok(validateOfferForSubmission(pendingDocument, 'admin').errors.some((error) => error.includes('Document must be verified before Admin approval: aadhaar')));

  const readinessMissing = assessOfferGenerationReadiness(withoutDocuments);
  assert.strictEqual(readinessMissing.ok, true);
  assert.deepStrictEqual(readinessMissing.missingDocuments, []);
  assert.ok(readinessMissing.sections.find((section) => section.id === 'documents' && section.optional && section.complete));
  const readinessComplete = assessOfferGenerationReadiness({
    ...fresher,
    documents: completeRequiredDocuments('Fresher'),
    commercial: { monthlyBillingRate: null, monthlyCtcCost: 50000, employerPfEsiCost: null, otherApprovedMonthlyCosts: null },
  });
  assert.strictEqual(readinessComplete.ok, true);
  assert.deepStrictEqual(readinessComplete.missingFields, []);
  assert.deepStrictEqual(readinessComplete.missingDocuments, []);
  const readinessFailedUpload = assessOfferGenerationReadiness({
    ...fresher,
    documents: completeRequiredDocuments('Fresher').map((document, index) => (
      index === 0 ? { ...document, originalFilename: '', storageKey: '' } : document
    )),
  });
  assert.strictEqual(readinessFailedUpload.ok, true);
  assert.deepStrictEqual(readinessFailedUpload.missingDocuments, []);

  const zeroDocuments = createHarness({ candidate: eligibleCandidate() });
  const bareOffer = completeReviewOffer('TL Review', 'TeamLead');
  bareOffer.documents = [];
  zeroDocuments.state.offers.push(bareOffer);
  const submittedWithoutDocuments = await zeroDocuments.service.applyTransition({
    tokenUser: actor(TL, 'TeamLead'),
    offerId: 'offer-tl',
    action: 'submit_to_hr',
  });
  assert.strictEqual(submittedWithoutDocuments.offer.currentStatus, 'HR Review');
  assert.deepStrictEqual(submittedWithoutDocuments.offer.documents, []);
  const adminReviewWithoutDocuments = await zeroDocuments.service.applyTransition({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    action: 'verify_and_send_to_admin',
  });
  assert.strictEqual(adminReviewWithoutDocuments.offer.currentStatus, 'Admin Review');
  const letterWithoutDocuments = await zeroDocuments.service.applyTransition({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    action: 'request_letter_preparation',
  });
  assert.strictEqual(letterWithoutDocuments.offer.currentStatus, 'Letter Preparation Requested');
  assert.deepStrictEqual(letterWithoutDocuments.offer.documents, []);
  const generatedWithoutDocuments = await zeroDocuments.service.applyTransition({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    action: 'generate_letter',
  });
  assert.strictEqual(generatedWithoutDocuments.offer.currentStatus, 'Letter Generated');
  assert.deepStrictEqual(generatedWithoutDocuments.offer.documents, []);

  assert.strictEqual(canReadOffer(actor(TL, 'TeamLead'), tlOffer), true);
  assert.strictEqual(canReadOffer(actor(TL, 'TeamLead'), {
    ...tlOffer,
    currentStatus: 'HR Review',
    currentAssigneeRole: 'HR',
    currentAssigneeUserId: '',
  }), false);
  assert.strictEqual(canReadOffer(actor(TL, 'TeamLead'), {
    ...tlOffer,
    currentStatus: 'Returned to TL',
    currentAssigneeRole: 'TeamLead',
    currentAssigneeUserId: TL,
  }), true);
  assert.strictEqual(canReadOffer(actor(TL, 'TeamLead'), {
    ...tlOffer,
    currentStatus: 'Letter Preparation Requested',
    currentAssigneeRole: 'HR',
  }), false);
  assert.strictEqual(canReadOffer(actor(TL_TWO, 'TeamLead'), tlOffer), false);
  const tlListWithHrTab = buildOfferListFilter(actor(TL, 'TeamLead'), {
    statuses: ['HR Review', 'Returned to HR'],
    returnedAssigneeRole: 'HR',
  });
  assert.ok(tlListWithHrTab.$and);
  assert.deepStrictEqual(tlListWithHrTab.$and[0].$or[0], {
    currentAssigneeRole: 'TeamLead',
    currentAssigneeUserId: TL,
  });
  assert.deepStrictEqual(tlListWithHrTab.$and[1], {
    $or: [
      { currentStatus: { $in: ['HR Review', 'Returned to HR'] } },
      { currentStatus: 'Returned by Admin', currentAssigneeRole: 'HR' },
    ],
  });
  assert.strictEqual(canEditDraft(actor(USER, 'User'), tlOffer), false);
  assert.strictEqual(canEditOfferDetails(actor(USER, 'User'), tlOffer), false);
  assert.strictEqual(canEditOfferDetails(actor(TL_TWO, 'TeamLead'), { ...tlOffer, currentStatus: 'HR Review' }), false);
  assert.strictEqual(canEditOfferDetails(actor(TL, 'TeamLead'), {
    ...tlOffer,
    currentStatus: 'HR Review',
    currentAssigneeRole: 'HR',
  }), false);
  assert.strictEqual(canEditOfferDetails(actor(TL, 'TeamLead'), {
    ...tlOffer,
    currentStatus: 'Returned by Admin',
    currentAssigneeRole: 'TeamLead',
    currentAssigneeUserId: TL,
  }), true);
  assert.strictEqual(canEditOfferDetails(actor(HR, 'HR'), { ...tlOffer, currentStatus: 'TL Review' }), true);
  assert.strictEqual(canEditOfferDetails(actor(HR, 'HR'), { ...tlOffer, currentStatus: 'MD Review' }), false);
  assert.strictEqual(canEditOfferDetails(actor(MD, 'MD'), { ...tlOffer, currentStatus: 'Letter Preparation Requested' }), false);
  assert.strictEqual(canEditOfferDetails(actor(MD, 'MD'), { ...tlOffer, currentStatus: 'TL Review' }), false);
  const hrFilter = buildOfferListFilter(actor(HR, 'HR'), { status: 'TL Review' });
  assert.ok(hrFilter.$and);
  assert.strictEqual(hrFilter.$and[1].currentStatus, 'TL Review');
  assert.strictEqual(canReadOffer(actor(HR, 'HR'), tlOffer), true);
  assert.strictEqual(canReadOffer(actor(HR, 'HR'), { ...tlOffer, currentStatus: 'Initiated' }), true);
  assert.strictEqual(canEditOfferDetails(actor(HR, 'HR'), { ...tlOffer, currentStatus: 'Initiated', currentAssigneeRole: 'TeamLead' }), true);
  const hrTlTabFilter = buildOfferListFilter(actor(HR, 'HR'), {
    statuses: ['Initiated', 'TL Review', 'Returned to TL', 'Returned to TL by MD'],
    returnedAssigneeRole: 'TeamLead',
  });
  const hrTlAccess = hrTlTabFilter.$and[0].$or.find((clause) => Array.isArray(clause.currentStatus?.$in));
  assert.ok(hrTlAccess.currentStatus.$in.includes('Initiated'));
  assert.ok(hrTlAccess.currentStatus.$in.includes('TL Review'));
  assert.ok(hrTlAccess.currentStatus.$in.includes('Returned to TL'));
  assert.deepStrictEqual(hrTlTabFilter.$and[1], {
    $or: [
      { currentStatus: { $in: ['Initiated', 'TL Review', 'Returned to TL', 'Returned to TL by MD'] } },
      { currentStatus: 'Returned by Admin', currentAssigneeRole: 'TeamLead' },
    ],
  });
  const hrTlList = createHarness({ candidate: eligibleCandidate() });
  hrTlList.state.offers.push({ ...tlOffer, _id: 'offer-initiated', currentStatus: 'Initiated', currentAssigneeRole: 'TeamLead' });
  hrTlList.state.offers.push({ ...tlOffer, _id: 'offer-md', currentStatus: 'MD Review', currentAssigneeRole: 'MD' });
  const hrTlListed = await hrTlList.service.listOffers({
    tokenUser: actor(HR, 'HR'),
    query: {
      statuses: 'Initiated,TL Review,Returned to TL,Returned to TL by MD',
      returnedAssigneeRole: 'TeamLead',
    },
  });
  assert.deepStrictEqual(hrTlListed.items.map((item) => item.id || item._id), ['offer-initiated']);
  assert.strictEqual(canReadOffer(actor(HR, 'HR'), { ...tlOffer, currentStatus: 'HR Review', currentAssigneeRole: 'HR' }), true);
  assert.strictEqual(canEditOfferDetails(actor(HR, 'HR'), { ...tlOffer, currentStatus: 'HR Review', currentAssigneeRole: 'HR' }), true);
  assert.strictEqual(canReadOffer(actor(HR, 'HR'), { ...tlOffer, currentStatus: 'MD Approved' }), false);
  assert.strictEqual(canReadOffer(actor(HR, 'HR'), { ...tlOffer, currentStatus: 'Offer Released' }), true);
  assert.strictEqual(canReadOffer(actor(USER, 'User'), tlOffer), false);
  const hrReviewFilter = buildOfferListFilter(actor(HR, 'HR'), {
    statuses: ['HR Review', 'Returned to HR'],
    returnedAssigneeRole: 'HR',
  });
  assert.deepStrictEqual(hrReviewFilter.$and[1], {
    $or: [
      { currentStatus: { $in: ['HR Review', 'Returned to HR'] } },
      { currentStatus: 'Returned by Admin', currentAssigneeRole: 'HR' },
    ],
  });
  const hrList = createHarness({ candidate: eligibleCandidate() });
  hrList.state.offers.push({ ...tlOffer, currentStatus: 'TL Review' });
  hrList.state.offers.push({ ...tlOffer, _id: 'offer-hr', currentStatus: 'HR Review', currentAssigneeRole: 'HR' });
  const listed = await hrList.service.listOffers({
    tokenUser: actor(HR, 'HR'),
    query: { statuses: 'HR Review,Returned to HR', returnedAssigneeRole: 'HR' },
  });
  assert.deepStrictEqual(hrList.state.lastFilter.$and[1], hrReviewFilter.$and[1]);
  assert.deepStrictEqual(listed.counts, []);
  assert.strictEqual(
    listed.items.find((item) => item.id === 'offer-hr').latestCandidateStatus,
    'Offer to be released',
  );
  const missingCandidate = createHarness({ candidate: eligibleCandidate() });
  missingCandidate.state.offers.push({
    ...tlOffer,
    _id: 'offer-missing',
    candidateSubdocumentId: '1'.repeat(24),
    currentStatus: 'HR Review',
    currentAssigneeRole: 'HR',
  });
  const missingListed = await missingCandidate.service.listOffers({
    tokenUser: actor(HR, 'HR'),
    query: { statuses: 'HR Review,Returned to HR', returnedAssigneeRole: 'HR' },
  });
  assert.strictEqual(missingListed.items[0].latestCandidateStatus, '');
  const emptyHistory = createHarness({ candidate: { ...eligibleCandidate(), Status: [] } });
  emptyHistory.state.offers.push({
    ...tlOffer,
    _id: 'offer-empty-status',
    currentStatus: 'HR Review',
    currentAssigneeRole: 'HR',
  });
  const emptyListed = await emptyHistory.service.listOffers({
    tokenUser: actor(HR, 'HR'),
    query: { statuses: 'HR Review,Returned to HR', returnedAssigneeRole: 'HR' },
  });
  assert.strictEqual(emptyListed.items[0].latestCandidateStatus, '');
  const ranged = await hrList.service.listOffers({
    tokenUser: actor(HR, 'HR'),
    query: {
      statuses: 'HR Review,Returned to HR',
      returnedAssigneeRole: 'HR',
      q: 'Asha',
      initiatedFrom: '2026-10-01T00:00:00.000Z',
      initiatedTo: '2026-10-27T18:29:59.999Z',
    },
  });
  const listCreated = ranged && hrList.state.lastFilter.$and.find((clause) => clause.createdAt);
  const countCreated = hrList.state.lastCountFilter.$and.find((clause) => clause.createdAt);
  assert.deepStrictEqual(listCreated.createdAt.$gte.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.deepStrictEqual(listCreated.createdAt.$lte.toISOString(), '2026-10-27T18:29:59.999Z');
  assert.deepStrictEqual(countCreated, listCreated);
  assert.strictEqual(hrList.state.lastCountFilter.$and.length, 3);
  assert.ok(hrList.state.lastFilter.$and.length > hrList.state.lastCountFilter.$and.length);
  await expectError(
    () => hrList.service.listOffers({
      tokenUser: actor(ADMIN, 'Admin'),
      query: { initiatedFrom: '2026-10-27T00:00:00.000Z', initiatedTo: '2026-10-01T00:00:00.000Z' },
    }),
    'INVALID_FIELD',
  );
  const dateOnly = await hrList.service.listOffers({
    tokenUser: actor(ADMIN, 'Admin'),
    query: { initiatedFrom: '2026-10-01', initiatedTo: '2026-10-27' },
  });
  assert.strictEqual(dateOnly.page, 1);
  assert.strictEqual(hrList.state.lastFilter.createdAt.$gte.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.strictEqual(hrList.state.lastFilter.createdAt.$lte.toISOString(), '2026-10-27T23:59:59.999Z');
  const tlDefaultFilter = buildOfferListFilter(actor(TL, 'TeamLead'), {});
  assert.ok(tlDefaultFilter.$and);
  assert.deepStrictEqual(tlDefaultFilter.$and[0].$or[0], {
    currentAssigneeRole: 'TeamLead',
    currentAssigneeUserId: TL,
  });
  assert.ok(tlDefaultFilter.$and[0].$or.some((clause) => (
    clause.responsibleTeamLeadUserId === TL && clause.currentAssigneeUserId === ''
  )));
  assert.deepStrictEqual(tlDefaultFilter.$and[1], {
    $or: [
      {
        currentStatus: {
          $in: ['Initiated', 'TL Review', 'Returned to TL', 'Returned to TL by MD'],
        },
      },
      { currentStatus: 'Returned by Admin', currentAssigneeRole: 'TeamLead' },
    ],
  });
  const tlWithStatusFilter = buildOfferListFilter(actor(TL, 'TeamLead'), {
    statuses: ['Initiated', 'TL Review', 'Returned to TL', 'Returned to TL by MD'],
    returnedAssigneeRole: 'TeamLead',
  });
  assert.deepStrictEqual(tlWithStatusFilter.$and[1], {
    $or: [
      { currentStatus: { $in: ['Initiated', 'TL Review', 'Returned to TL', 'Returned to TL by MD'] } },
      { currentStatus: 'Returned by Admin', currentAssigneeRole: 'TeamLead' },
    ],
  });
  assert.strictEqual(canReadOffer(actor(TL, 'TeamLead'), {
    ...tlOffer,
    currentStatus: 'Offer Accepted',
    currentAssigneeRole: 'TeamLead',
    currentAssigneeUserId: TL,
  }), true);
  assert.ok(!JSON.stringify(tlDefaultFilter).includes('Offer Released'));
  assert.ok(!JSON.stringify(tlDefaultFilter).includes('HR Review'));

  assert.throws(() => resolvePrivateDocumentPath(`..${path.sep}secrets.pdf`), /Invalid document reference/);
  assert.throws(() => resolvePrivateDocumentPath('folder/file.pdf'), /Invalid document reference/);
  assert.throws(() => resolvePrivateDocumentPath('..\\secrets.pdf'), /Invalid document reference/);
  const safePath = resolvePrivateDocumentPath('offer-abc.pdf', path.join(__dirname, 'offer-test-files'));
  assert.ok(safePath.endsWith(`${path.sep}offer-abc.pdf`));

  const sourceEventId = buildOfferSourceEventId('offer-1', 'h-1');
  let notificationCalls = 0;
  const notificationModel = {
    async create() {
      notificationCalls += 1;
      if (notificationCalls > 1) {
        const error = new Error('dup');
        error.code = 11000;
        throw error;
      }
      return { sourceEventId };
    },
  };
  const payload = {
    recipientUserId: TL,
    title: 'Offer',
    message: 'Offer ORR-2026-0001 for Asha Rao is now TL Review.',
    link: '/offers/offer-1',
    sourceEventId,
    actorUserId: ADMIN,
  };
  assert.strictEqual((await createOfferWorkflowNotification(payload, notificationModel)).created, true);
  assert.strictEqual((await createOfferWorkflowNotification(payload, notificationModel)).duplicate, true);

  const poisoned = JSON.parse(JSON.stringify(tlOffer));
  poisoned.commercial.employerPfEsiCost = 10;
  poisoned.commercial.otherApprovedMonthlyCosts = 3;
  const patched = applyDraftPatch(poisoned, {
    commercial: { monthlyBillingRate: 100, monthlyCtcCost: 40, employerPfEsiCost: 999, otherApprovedMonthlyCosts: 888, monthlyMargin: 1 },
  });
  assert.strictEqual(patched.commercial.monthlyTotalCost, 40);
  assert.strictEqual(patched.commercial.monthlyMargin, 60);
  assert.strictEqual(patched.commercial.employerPfEsiCost, 10);
  assert.strictEqual(patched.commercial.otherApprovedMonthlyCosts, 3);
  assert.strictEqual(poisoned.commercial.monthlyMargin, 999);

  const monthsPatched = applyDraftPatch(JSON.parse(JSON.stringify(tlOffer)), {
    client: { contractTerms: '12' },
  });
  assert.strictEqual(monthsPatched.client.contractTerms, '12');
  const historicalTerms = applyDraftPatch(JSON.parse(JSON.stringify(tlOffer)), {
    client: { contractTerms: 'C2H' },
  });
  assert.strictEqual(historicalTerms.client.contractTerms, 'C2H');
  const withContractType = JSON.parse(JSON.stringify(tlOffer));
  withContractType.employment.contractType = 'C2H';
  const storedType = applyDraftPatch(withContractType, { employment: { contractType: 'FTE' } });
  assert.strictEqual(storedType.employment.contractType, 'FTE');
  const blankType = applyDraftPatch(storedType, { employment: { contractType: '' } });
  assert.strictEqual(blankType.employment.contractType, 'FTE');
  const nullType = applyDraftPatch(storedType, { employment: { contractType: null } });
  assert.strictEqual(nullType.employment.contractType, 'FTE');
  assert.throws(
    () => applyDraftPatch(JSON.parse(JSON.stringify(tlOffer)), { client: { contractTerms: '-3' } }),
    /positive number of months/,
  );

  const confidentialBase = JSON.parse(JSON.stringify(tlOffer));
  confidentialBase.otherExpenses = [{ description: 'Laptop', amount: 30000 }];
  confidentialBase.commercialNotes = 'Keep internal';
  confidentialBase.internalRemarks = 'Do not share';
  const omitted = applyDraftPatch(confidentialBase, { employment: { workLocation: 'Pune' } });
  assert.strictEqual(omitted.otherExpenses[0].description, 'Laptop');
  assert.strictEqual(omitted.commercialNotes, 'Keep internal');
  assert.strictEqual(omitted.internalRemarks, 'Do not share');
  const cleaned = applyDraftPatch(confidentialBase, {
    otherExpenses: [
      { description: 'Laptop Purchase', amount: 30000 },
      { description: '', amount: '' },
      { description: 'Joining Kit', amount: '5000' },
    ],
    commercialNotes: 'Bill the laptop separately.',
  });
  assert.strictEqual(cleaned.otherExpenses.length, 2);
  assert.strictEqual(cleaned.otherExpenses[1].amount, 5000);
  assert.strictEqual(cleaned.commercialNotes, 'Bill the laptop separately.');
  assert.strictEqual(cleaned.internalRemarks, 'Do not share');
  assert.throws(
    () => applyDraftPatch(confidentialBase, { otherExpenses: [{ description: 'Bad', amount: -5 }] }),
    /zero or greater/,
  );
  const clearedChoice = applyDraftPatch(confidentialBase, {
    hasOtherExpenses: false,
    otherExpenses: [{ description: 'Laptop', amount: 1 }],
  });
  assert.deepStrictEqual(clearedChoice.otherExpenses, []);
  assert.strictEqual(clearedChoice.hasOtherExpenses, false);
  assert.strictEqual(clearedChoice.commercialNotes, 'Keep internal');
  const keepYes = applyDraftPatch(confidentialBase, { hasOtherExpenses: true, otherExpenses: [] });
  assert.strictEqual(keepYes.hasOtherExpenses, true);
  assert.deepStrictEqual(keepYes.otherExpenses, []);

  const confidential = createHarness({ candidate: eligibleCandidate() });
  confidential.state.offers.push(completeReviewOffer('TL Review', 'TeamLead'));
  confidential.state.offers[0].otherExpenses = [{ description: 'Laptop', amount: 30000 }];
  confidential.state.offers[0].commercialNotes = 'Keep internal';
  confidential.state.offers[0].internalRemarks = 'Do not share';
  await expectError(
    () => confidential.service.saveDraft({
      tokenUser: actor(TL, 'TeamLead'),
      offerId: 'offer-tl',
      payload: { otherExpenses: [{ description: 'Changed', amount: 1 }] },
    }),
    'OFFER_FORBIDDEN',
  );
  await expectError(
    () => confidential.service.saveDraft({
      tokenUser: actor(TL, 'TeamLead'),
      offerId: 'offer-tl',
      payload: { hasOtherExpenses: false },
    }),
    'OFFER_FORBIDDEN',
  );
  const tlView = await confidential.service.getOffer({
    tokenUser: actor(TL, 'TeamLead'),
    offerId: 'offer-tl',
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(tlView.offer, 'hasOtherExpenses'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(tlView.offer, 'otherExpenses'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(tlView.offer, 'commercialNotes'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(tlView.offer, 'internalRemarks'), false);
  const tlPreserved = await confidential.service.saveDraft({
    tokenUser: actor(TL, 'TeamLead'),
    offerId: 'offer-tl',
    payload: { employment: { workLocation: 'Pune' } },
  });
  assert.strictEqual(confidential.state.offers[0].otherExpenses[0].amount, 30000);
  assert.strictEqual(confidential.state.offers[0].commercialNotes, 'Keep internal');
  assert.strictEqual(tlPreserved.offer.commercialNotes, undefined);

  const hrExpenseEdit = createHarness({ candidate: eligibleCandidate() });
  hrExpenseEdit.state.offers.push(completeReviewOffer('HR Review', 'HR'));
  const hrExpenseSaved = await hrExpenseEdit.service.saveDraft({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    payload: {
      otherExpenses: [
        { description: 'Laptop Purchase', amount: 30000 },
        { description: '', amount: '' },
        { description: 'Documentation', amount: 2000 },
      ],
      commercialNotes: 'Bill the laptop separately.',
      internalRemarks: 'Confirm kit vendor.',
    },
  });
  assert.strictEqual(hrExpenseSaved.offer.otherExpenses.length, 2);
  assert.strictEqual(hrExpenseSaved.offer.otherExpenses[0].amount, 30000);
  assert.strictEqual(hrExpenseSaved.offer.commercialNotes, 'Bill the laptop separately.');
  const hrReopened = await hrExpenseEdit.service.getOffer({ tokenUser: actor(HR, 'HR'), offerId: 'offer-tl' });
  assert.strictEqual(hrReopened.offer.internalRemarks, 'Confirm kit vendor.');
  await hrExpenseEdit.service.saveDraft({
    tokenUser: actor(HR, 'HR'),
    offerId: 'offer-tl',
    payload: { client: { clientLocation: 'Bengaluru' } },
  });
  assert.strictEqual(hrExpenseEdit.state.offers[0].otherExpenses.length, 2);
  assert.strictEqual(hrExpenseEdit.state.offers[0].internalRemarks, 'Confirm kit vendor.');
  await expectError(
    () => hrExpenseEdit.service.saveDraft({
      tokenUser: actor(HR, 'HR'),
      offerId: 'offer-tl',
      payload: { otherExpenses: [{ description: 'Bad', amount: -5 }] },
    }),
    'INVALID_FIELD',
  );
  const adminExpenseSaved = await hrExpenseEdit.service.saveDraft({
    tokenUser: actor(ADMIN, 'Admin'),
    offerId: 'offer-tl',
    payload: {
      otherExpenses: [{ description: 'Joining Kit', amount: 5000 }],
      commercialNotes: 'Updated by admin.',
    },
  });
  assert.strictEqual(adminExpenseSaved.offer.otherExpenses[0].description, 'Joining Kit');
  assert.strictEqual(adminExpenseSaved.offer.commercialNotes, 'Updated by admin.');
  assert.strictEqual(adminExpenseSaved.offer.internalRemarks, 'Confirm kit vendor.');

  function searchClauses(filter) {
    const groups = [];
    if (Array.isArray(filter?.$or)) groups.push(filter.$or);
    (filter?.$and || []).forEach((clause) => {
      if (Array.isArray(clause?.$or)) groups.push(clause.$or);
    });
    return groups.flat();
  }

  const hrStatusSearch = createHarness({ candidate: eligibleCandidate() });
  await hrStatusSearch.service.listOffers({
    tokenUser: actor(HR, 'HR'),
    query: { q: 'Offer to be released', page: 1 },
  });
  const hrClauses = searchClauses(hrStatusSearch.state.lastFilter);
  assert.ok(hrClauses.some((clause) => clause['candidateSnapshot.firstName']));
  assert.ok(hrClauses.some((clause) => clause.currentStatus));
  assert.ok(hrClauses.some((clause) => (
    Array.isArray(clause.candidateSubdocumentId?.$in) && clause.candidateSubdocumentId.$in.includes(SUB)
  )));
  await hrStatusSearch.service.listOffers({
    tokenUser: actor(HR, 'HR'),
    query: { q: 'Joined', statuses: 'HR Review,Returned to HR', page: 2 },
  });
  const olderStatusClauses = searchClauses(hrStatusSearch.state.lastFilter);
  assert.ok(olderStatusClauses.some((clause) => clause.currentStatus));
  assert.ok(!olderStatusClauses.some((clause) => clause.candidateSubdocumentId));
  const hrTabFilter = JSON.stringify(hrStatusSearch.state.lastFilter);
  assert.ok(hrTabFilter.includes('HR Review'));
  assert.ok(hrTabFilter.includes('Returned to HR'));

  const adminStatusSearch = createHarness({ candidate: eligibleCandidate() });
  await adminStatusSearch.service.listOffers({
    tokenUser: actor(ADMIN, 'Admin'),
    query: { q: 'Offer to be released' },
  });
  const adminClauses = searchClauses(adminStatusSearch.state.lastFilter);
  assert.deepStrictEqual(adminClauses.map((clause) => Object.keys(clause)[0]), [
    'offerRequestNumber',
    'candidateSnapshot.firstName',
    'candidateSnapshot.lastName',
    'candidateSnapshot.technicalSkills',
    'employment.proposedDesignation',
    'client.clientName',
  ]);

  const app = express();
  app.use(express.json());
  let routeCalls = 0;
  registerOfferRoutes(app, {
    initiateOffer: async () => {
      routeCalls += 1;
      return { offer: { id: 'x' } };
    },
    listOffers: async () => ({ items: [], page: 1, limit: 20, total: 0 }),
    listInitiationRecipients: async () => [{ id: TL, name: 'Lata', role: 'TeamLead' }],
  });

  async function call(method, urlPath, enabled) {
    process.env.OFFER_WORKFLOW_ENABLED = enabled ? 'true' : 'false';
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end();
    });
    await new Promise((resolve) => server.close(resolve));
    return response;
  }

  const disabledHttp = await call('POST', '/api/offers', false);
  assert.strictEqual(disabledHttp.status, 403);
  assert.strictEqual(disabledHttp.body.code, 'OFFER_WORKFLOW_DISABLED');
  assert.strictEqual(routeCalls, 0);
  const enabledHttp = await call('GET', '/api/offers', true);
  assert.strictEqual(enabledHttp.status, 401);
  assert.strictEqual(routeCalls, 0);

  const manualStatus = createHarness({
    candidate: baseCandidate([
      { Status: 'Offer to be released', Date: '2026-03-01T00:00:00.000Z' },
      { Status: 'Offer Released', Date: '2026-04-01T00:00:00.000Z' },
    ]),
    leads: { [HR]: { id: HR, name: 'Meera', role: 'HR', active: true } },
  });
  const createdReleased = await manualStatus.service.ensureOfferForHrManualStatus({
    tokenUser: actor(HR, 'HR'),
    candidateSubdocumentId: SUB,
    status: 'Offer Released',
  });
  assert.strictEqual(createdReleased.created, true);
  assert.ok(createdReleased.offerId);
  assert.strictEqual(manualStatus.state.offers.length, 1);
  assert.strictEqual(manualStatus.state.offers[0].currentStatus, 'Offer Released');
  assert.strictEqual(manualStatus.state.offers[0].isOpen, true);
  assert.strictEqual(manualStatus.state.offers[0].teamLeadSelectionMode, 'direct_hr_skip');
  assert.strictEqual(manualStatus.state.notifications.length, 0);
  const reusedReleased = await manualStatus.service.ensureOfferForHrManualStatus({
    tokenUser: actor(HR, 'HR'),
    candidateSubdocumentId: SUB,
    status: 'Offer Accepted',
  });
  assert.strictEqual(reusedReleased.created, false);
  assert.strictEqual(reusedReleased.offerId, createdReleased.offerId);
  assert.strictEqual(manualStatus.state.offers.length, 1);
  assert.strictEqual(manualStatus.state.offers[0].currentStatus, 'Offer Released');
  const ignoredRole = await manualStatus.service.ensureOfferForHrManualStatus({
    tokenUser: actor(ADMIN, 'Admin'),
    candidateSubdocumentId: SUB,
    status: 'Joined',
  });
  assert.strictEqual(ignoredRole, null);
  const ignoredStatus = await manualStatus.service.ensureOfferForHrManualStatus({
    tokenUser: actor(HR, 'HR'),
    candidateSubdocumentId: SUB,
    status: 'HR Round',
  });
  assert.strictEqual(ignoredStatus, null);
  assert.strictEqual(manualStatus.state.offers.length, 1);

  const joinedManual = createHarness({
    candidate: baseCandidate([
      { Status: 'Offer Released', Date: '2026-03-01T00:00:00.000Z' },
      { Status: 'Joined', Date: '2026-04-02T00:00:00.000Z' },
    ]),
    leads: { [HR]: { id: HR, name: 'Meera', role: 'HR', active: true } },
  });
  const joinedIndicators = await joinedManual.service.listOpenOfferIndicators({ tokenUser: actor(HR, 'HR') });
  assert.strictEqual(joinedIndicators.length, 1);
  assert.strictEqual(joinedIndicators[0].canOpen, true);
  assert.strictEqual(joinedIndicators[0].currentStatus, 'Joined');
  assert.strictEqual(joinedIndicators[0].offerId, joinedManual.state.offers[0]._id);
  assert.strictEqual(joinedManual.state.offers[0].isOpen, false);
  const joinedAgain = await joinedManual.service.listOpenOfferIndicators({ tokenUser: actor(HR, 'HR') });
  assert.strictEqual(joinedAgain.length, 1);
  assert.strictEqual(joinedManual.state.offers.length, 1);

  const declinedManual = createHarness({
    candidate: baseCandidate([
      { Status: 'Offer Released', Date: '2026-03-01T00:00:00.000Z' },
      { Status: 'Candidate Declined', Date: '2026-04-03T00:00:00.000Z' },
    ]),
    leads: { [HR]: { id: HR, name: 'Meera', role: 'HR', active: true } },
  });
  const declinedIndicators = await declinedManual.service.listOpenOfferIndicators({ tokenUser: actor(HR, 'HR') });
  assert.strictEqual(declinedIndicators.length, 1);
  assert.strictEqual(declinedIndicators[0].currentStatus, 'Candidate Declined');
  assert.strictEqual(declinedIndicators[0].canOpen, true);
  assert.ok(declinedIndicators[0].offerId);
  const existingDeclined = await declinedManual.service.ensureOfferForHrManualStatus({
    tokenUser: actor(HR, 'HR'),
    candidateSubdocumentId: SUB,
    status: 'Candidate Declined',
  });
  assert.strictEqual(existingDeclined.created, false);
  assert.strictEqual(existingDeclined.offerId, declinedIndicators[0].offerId);
  assert.strictEqual(declinedManual.state.offers.length, 1);

  const earlyStatus = createHarness({
    candidate: baseCandidate([
      { Status: 'HR Round', Date: '2026-04-04T00:00:00.000Z' },
    ]),
    leads: { [HR]: { id: HR, name: 'Meera', role: 'HR', active: true } },
  });
  const earlyIndicators = await earlyStatus.service.listOpenOfferIndicators({ tokenUser: actor(HR, 'HR') });
  assert.strictEqual(earlyIndicators.length, 0);
  assert.strictEqual(earlyStatus.state.offers.length, 0);

  const statusOrder = createHarness();
  const statusRows = [
    ['a'.repeat(24), 'Joined', '2026-06-02T00:00:00.000Z'],
    ['b'.repeat(24), 'Offer to be released', '2026-01-01T00:00:00.000Z'],
    ['c'.repeat(24), 'Offer Released', '2026-03-01T00:00:00.000Z'],
    ['d'.repeat(24), 'Offer to be released', '2026-05-01T00:00:00.000Z'],
    ['e'.repeat(24), 'Candidate Declined', '2026-07-01T00:00:00.000Z'],
    ['f'.repeat(24), 'Offer Accepted', '2026-02-01T00:00:00.000Z'],
    ['1'.repeat(24), 'Onboard Confirmation', '2026-04-01T00:00:00.000Z'],
    ['2'.repeat(24), 'HR Round', '2026-08-01T00:00:00.000Z'],
  ];
  statusOrder.state.candidateStatusDetails = new Map(statusRows.map(([id, status, updatedAt]) => (
    [id, { status, updatedAt }]
  )));
  statusRows.forEach(([id, , updatedAt], index) => {
    statusOrder.state.offers.push({
      ...tlOffer,
      _id: `offer-${index}`,
      offerRequestNumber: `ORN-STATUS-${index}`,
      candidateSubdocumentId: id,
      currentStatus: 'HR Review',
      currentAssigneeRole: 'HR',
      currentAssigneeUserId: HR,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt,
    });
  });
  const ordered = await statusOrder.service.listOffers({
    tokenUser: actor(ADMIN, 'Admin'),
    query: {},
  });
  assert.deepStrictEqual(
    ordered.items.map((item) => item.latestCandidateStatus),
    [
      'Offer to be released',
      'Offer to be released',
      'Offer Released',
      'Offer Accepted',
      'Onboard Confirmation',
      'Joined',
      'Candidate Declined',
      'HR Round',
    ],
  );
  assert.deepStrictEqual(ordered.items.slice(0, 2).map((item) => item.candidateSubdocumentId), [
    'd'.repeat(24),
    'b'.repeat(24),
  ]);
  assert.strictEqual(ordered.total, 8);
  const releasedOnly = await statusOrder.service.listOffers({
    tokenUser: actor(HR, 'HR'),
    query: { candidateStatus: 'Offer to be Released' },
  });
  assert.deepStrictEqual(releasedOnly.items.map((item) => item.candidateSubdocumentId), [
    'd'.repeat(24),
    'b'.repeat(24),
  ]);
  assert.strictEqual(releasedOnly.total, 2);
  for (const statusName of [
    'Offer Released',
    'Offer Accepted',
    'Onboard Confirmation',
    'Joined',
    'Candidate Declined',
  ]) {
    const filtered = await statusOrder.service.listOffers({
      tokenUser: actor(ADMIN, 'Admin'),
      query: { candidateStatus: statusName },
    });
    assert.deepStrictEqual(filtered.items.map((item) => item.latestCandidateStatus), [statusName]);
  }
  const secondPage = await statusOrder.service.listOffers({
    tokenUser: actor(HR, 'HR'),
    query: { page: 2, limit: 2 },
  });
  assert.deepStrictEqual(secondPage.items.map((item) => item.latestCandidateStatus), [
    'Offer Released',
    'Offer Accepted',
  ]);
  const tlList = createHarness();
  tlList.state.candidateStatusDetails = new Map([
    ['b'.repeat(24), { status: 'Offer to be released', updatedAt: '2026-05-01T00:00:00.000Z' }],
  ]);
  tlList.state.offers.push({
    ...tlOffer,
    _id: 'offer-tl-visible',
    candidateSubdocumentId: 'b'.repeat(24),
    currentStatus: 'TL Review',
    currentAssigneeRole: 'TeamLead',
    currentAssigneeUserId: TL,
    responsibleTeamLeadUserId: TL,
  });
  const tlUnfiltered = await tlList.service.listOffers({
    tokenUser: actor(TL, 'TeamLead'),
    query: { candidateStatus: 'Joined' },
  });
  assert.deepStrictEqual(tlUnfiltered.items.map((item) => item.id), ['offer-tl-visible']);
  await expectError(
    () => statusOrder.service.listOffers({
      tokenUser: actor(ADMIN, 'Admin'),
      query: { candidateStatus: 'HR Round' },
    }),
    'INVALID_STATUS',
  );

  console.log('offerWorkflow.service.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
