const mongoose = require('mongoose');
const CandidateModel = require('../models/Candidate');
const NewUser = require('../models/User');
const NewRequirment = require('../models/Requirement');
const NewClient = require('../models/Client');
const OfferRequest = require('../models/OfferRequest');
const OfferApprovalHistory = require('../models/OfferApprovalHistory');
const OfferCounter = require('../models/OfferCounter');
const { isOfferWorkflowEnabled } = require('../utils/offerFeatureFlag');
const {
  OFFER_STATUSES,
  isOpenOfferStatus,
  offerWorkflowStageId,
  offerStatusDisplayLabel,
  isTlStageSkipped,
} = require('../utils/offerWorkflow.constants');
const { ACTIVE_STATUS, isSupportedUserType } = require('../utils/constants');
const { getLatestStatusEntry } = require('../utils/statusRemarks');
const logger = require('../utils/logger');
const {
  resolvePrivateDocumentPath,
  sanitizeOriginalFilename,
} = require('../config/offerDocumentUpload');
const {
  buildOfferSourceEventId,
  createOfferWorkflowNotification,
} = require('./offerNotification.service');
const { calculateCommercials, resolveMonthlyCtcCost } = require('./offerFinance.service');
const { canReadOffer, canEditOfferDetails, buildOfferListFilter } = require('./offerAccess.service');
const {
  appendCandidateStatusHistory,
  CandidateStatusUpdateError,
} = require('./candidateStatusUpdate.service');
const {
  OfferWorkflowError,
  isMongoIdString,
  normalizeId,
  collectRecruiterIds,
  primaryRecruiterId,
  assertInitiationStatus,
  getOfferLatestCandidateStatus,
  buildCandidateSnapshot,
  buildEmploymentSeed,
  buildClientSeed,
  emptyCommercials,
  resolveTeamLeadSelection,
  applyDraftPatch,
  assessOfferGenerationReadiness,
  isOfferGenerationSubmission,
  validateOfferForSubmission,
  resolveTransition,
  applyDocumentVerifications,
  assertDocumentType,
  canUploadDocuments,
  notificationAudience,
  clone,
} = require('./offerWorkflow.rules');

const POST_OFFER_ACTIONS = new Set([
  'mark_accepted',
  'mark_declined',
  'confirm_onboard',
  'mark_joined',
]);

let indexPreparation = null;

async function prepareOfferStorage() {
  if (!indexPreparation) {
    indexPreparation = Promise.all([
      OfferRequest.syncIndexes(),
      OfferApprovalHistory.syncIndexes(),
      OfferCounter.syncIndexes(),
    ]).catch((error) => {
      indexPreparation = null;
      throw error;
    });
  }
  return indexPreparation;
}

function toLead(user) {
  if (!user) return null;
  return {
    id: String(user._id),
    name: user.EmployeeName || '',
    role: user.UserType,
    active: user.Status === ACTIVE_STATUS,
  };
}

async function loadActor(tokenUser) {
  if (!tokenUser?.id || !isMongoIdString(tokenUser.id)) {
    throw new OfferWorkflowError('Authentication required.', 401, 'AUTH_REQUIRED');
  }
  const user = await NewUser.findById(tokenUser.id)
    .select('_id UserType Status EmployeeName')
    .lean();
  if (!user || user.Status !== ACTIVE_STATUS) {
    throw new OfferWorkflowError('Your account cannot perform this action.', 403, 'ACCOUNT_INACTIVE');
  }
  if (user.UserType !== tokenUser.role) {
    throw new OfferWorkflowError('Your session role does not match your account.', 403, 'ROLE_MISMATCH');
  }
  return { id: String(user._id), role: user.UserType, name: user.EmployeeName || '' };
}

async function findCandidateContext(subdocumentId) {
  if (!isMongoIdString(subdocumentId)) return null;
  const main = await CandidateModel.findOne({ 'candidates._id': subdocumentId });
  if (!main) return null;
  const candidate = main.candidates.id(subdocumentId);
  if (!candidate) return null;
  return {
    main: {
      _id: String(main._id),
      reqId: main.reqId == null ? '' : String(main.reqId),
      recruiterId: Array.isArray(main.recruiterId) ? main.recruiterId.map((id) => String(id)) : [],
    },
    candidate: candidate.toObject(),
  };
}

async function findCandidateIdsByLatestStatus(pattern) {
  if (!(pattern instanceof RegExp)) return [];
  const documents = await CandidateModel.find({ 'candidates.Status.Status': pattern })
    .select('candidates._id candidates.Status')
    .lean();
  const ids = [];
  documents.forEach((document) => {
    (document.candidates || []).forEach((candidate) => {
      const latest = getOfferLatestCandidateStatus(candidate);
      if (latest && pattern.test(latest)) ids.push(String(candidate._id));
    });
  });
  return ids;
}

async function findLatestCandidateStatusDetails(subdocumentIds) {
  const ids = [...new Set((subdocumentIds || []).map((id) => String(id || '')).filter(isMongoIdString))];
  const details = new Map();
  if (!ids.length) return details;
  const documents = await CandidateModel.find({ 'candidates._id': { $in: ids } })
    .select('candidates._id candidates.Status')
    .lean();
  const wanted = new Set(ids);
  documents.forEach((document) => {
    (document.candidates || []).forEach((candidate) => {
      const id = String(candidate?._id || '');
      if (!wanted.has(id)) return;
      const entry = getLatestStatusEntry(candidate?.Status || []);
      details.set(id, {
        status: String(entry?.Status || '').trim(),
        updatedAt: entry?.Date || null,
      });
    });
  });
  return details;
}

async function findLatestCandidateStatuses(subdocumentIds) {
  const details = await findLatestCandidateStatusDetails(subdocumentIds);
  const statuses = new Map();
  details.forEach((detail, id) => statuses.set(id, detail.status));
  return statuses;
}

async function findOpenOffer(candidateSubdocumentId) {
  return OfferRequest.findOne({ candidateSubdocumentId, isOpen: true }).lean();
}

async function findLatestOfferForCandidate(candidateSubdocumentId) {
  if (!candidateSubdocumentId) return null;
  return OfferRequest.findOne({ candidateSubdocumentId })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
}

async function listClosedWorkflowOffers() {
  return OfferRequest.find({
    isOpen: false,
    currentStatus: { $in: ['Joined', 'Candidate Declined'] },
  })
    .select('candidateSubdocumentId offerRequestNumber currentStatus currentAssigneeUserId currentAssigneeRole currentAssigneeName responsibleTeamLeadUserId responsibleHrUserId responsibleHrName createdAt')
    .sort({ createdAt: -1, _id: -1 })
    .lean();
}

async function findTeamLeadsForRecruiters(recruiterIds) {
  if (!recruiterIds.length) return [];
  const leads = await NewUser.find({
    UserType: 'TeamLead',
    Status: ACTIVE_STATUS,
    Team: { $in: recruiterIds },
  }).select('_id EmployeeName UserType Status').lean();
  const seen = new Set();
  return leads.map(toLead).filter((lead) => {
    if (!lead || seen.has(lead.id)) return false;
    seen.add(lead.id);
    return true;
  });
}

async function findActiveTeamLead(teamLeadUserId) {
  if (!isMongoIdString(teamLeadUserId)) return null;
  const user = await NewUser.findById(teamLeadUserId)
    .select('_id EmployeeName UserType Status')
    .lean();
  return toLead(user);
}

/** Active Team Leads who already have this client on their Admin client assignment. */
async function findActiveTeamLeadsForClient(clientId) {
  if (!isMongoIdString(clientId)) return [];
  const leads = await NewUser.find({
    UserType: 'TeamLead',
    Status: ACTIVE_STATUS,
    Clients: clientId,
  }).select('_id EmployeeName UserType Status').lean();
  return leads
    .map(toLead)
    .filter((lead) => lead && lead.active === true && lead.id)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

async function findRequirement(reqId) {
  const value = String(reqId || '').trim();
  if (!value) return null;
  if (isMongoIdString(value)) {
    const byId = await NewRequirment.findById(value).lean();
    if (byId) return byId;
  }
  return NewRequirment.findOne({ regId: value }).lean();
}

async function findClient(requirement) {
  const clientId = String(requirement?.clientId || '').trim();
  if (!clientId) return null;
  if (isMongoIdString(clientId)) {
    const byId = await NewClient.findById(clientId).lean();
    if (byId) return byId;
  }
  return NewClient.findOne({ ClientCode: clientId }).lean();
}

const OFFER_NUMBER_COUNTER_YEAR = 0;

function formatOfferRequestNumber(seq) {
  const number = Number(seq);
  if (!Number.isInteger(number) || number < 1) {
    throw new OfferWorkflowError('Could not allocate an offer request number.', 500, 'OFFER_NUMBER_FAILED');
  }
  return `ORN-${String(number).padStart(3, '0')}`;
}

async function allocateOfferNumber() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const counter = await OfferCounter.findOneAndUpdate(
        { year: OFFER_NUMBER_COUNTER_YEAR },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      return formatOfferRequestNumber(counter.seq);
    } catch (error) {
      if (error && error.code === 11000 && attempt < 2) continue;
      throw error;
    }
  }
  throw new OfferWorkflowError('Could not allocate an offer request number.', 500, 'OFFER_NUMBER_FAILED');
}

function parseInitiatedBound(value, edge) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly
    ? `${raw}T${edge === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`
    : raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new OfferWorkflowError(
      edge === 'end' ? 'initiatedTo is not a valid date.' : 'initiatedFrom is not a valid date.',
      400,
      'INVALID_FIELD',
    );
  }
  return parsed;
}

function initiatedCreatedAtClause(query = {}) {
  if (!query.initiatedFrom && !query.initiatedTo) return null;
  const createdAt = {};
  const from = parseInitiatedBound(query.initiatedFrom, 'start');
  const to = parseInitiatedBound(query.initiatedTo, 'end');
  if (from) createdAt.$gte = from;
  if (to) createdAt.$lte = to;
  if (from && to && from > to) {
    throw new OfferWorkflowError('initiatedTo cannot be earlier than initiatedFrom.', 400, 'INVALID_FIELD');
  }
  return createdAt;
}

function applyCreatedAtClause(filter, createdAt) {
  if (!createdAt) return filter;
  if (filter.$and) filter.$and.push({ createdAt });
  else filter.createdAt = createdAt;
  return filter;
}

async function insertOffer(payload) {
  const doc = await OfferRequest.create(payload);
  return doc.toObject();
}

async function conditionalUpdate(offerId, expectedStatus, expectedVersion, setFields) {
  return OfferRequest.findOneAndUpdate(
    { _id: offerId, currentStatus: expectedStatus, workflowVersion: expectedVersion },
    {
      $set: setFields,
      $unset: { education: '', 'sourceSnapshot.education': '' },
      $inc: { workflowVersion: 1 },
    },
    { new: true },
  ).lean();
}

async function insertHistory(record) {
  const doc = await OfferApprovalHistory.create(record);
  return doc.toObject();
}

async function queryOffers(filter, page, limit, options = {}) {
  const find = OfferRequest.find(filter).sort({ createdAt: -1, _id: -1 });
  const itemsQuery = options.all ? find : find.skip((page - 1) * limit).limit(limit);
  const [items, total] = await Promise.all([
    itemsQuery.lean(),
    OfferRequest.countDocuments(filter),
  ]);
  return { items, total };
}

async function countOfferGroups(filter) {
  const rows = await OfferRequest.aggregate([
    { $match: filter },
    {
      $group: {
        _id: {
          status: '$currentStatus',
          assigneeRole: '$currentAssigneeRole',
          letterPreparationSource: '$letterPreparationSource',
        },
        count: { $sum: 1 },
      },
    },
  ]);
  return rows.map((row) => ({
    status: row._id?.status || '',
    assigneeRole: row._id?.assigneeRole || '',
    letterPreparationSource: row._id?.letterPreparationSource || '',
    count: row.count,
  }));
}

async function findOfferById(offerId) {
  if (!isMongoIdString(offerId)) return null;
  return OfferRequest.findById(offerId).lean();
}

async function listOpenOffers() {
  return OfferRequest.find({ isOpen: true })
    .select('candidateSubdocumentId offerRequestNumber currentStatus currentAssigneeUserId currentAssigneeRole currentAssigneeName responsibleTeamLeadUserId responsibleHrUserId responsibleHrName createdAt')
    .lean();
}

async function listHistory(offerRequestId) {
  return OfferApprovalHistory.find({ offerRequestId: String(offerRequestId) })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
}

const RETURN_REASON_ACTIONS = [
  'return_to_tl',
  'return_to_tl_by_md',
  'return_to_hr',
  'return_to_md',
  'admin_return',
  'admin_return_to_tl',
  'admin_return_to_hr',
  'admin_return_to_md',
];

async function latestReturnComments(offerIds = []) {
  const ids = [...new Set(offerIds.map((id) => String(id)).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await OfferApprovalHistory.find({
    offerRequestId: { $in: ids },
    action: { $in: RETURN_REASON_ACTIONS },
  }).sort({ createdAt: -1, _id: -1 }).select('offerRequestId comments').lean();
  const reasons = new Map();
  rows.forEach((row) => {
    const id = String(row.offerRequestId);
    const comments = String(row.comments || '').trim();
    if (!reasons.has(id) && comments) reasons.set(id, comments);
  });
  return reasons;
}

async function findActiveUsersByRole(role) {
  if (!isSupportedUserType(role)) return [];
  const users = await NewUser.find({ UserType: role, Status: ACTIVE_STATUS }).select('_id EmployeeName').lean();
  return users.map((user) => ({ id: String(user._id), name: user.EmployeeName || role }));
}

async function findActiveUsersByRoles(roles = []) {
  const allowed = (Array.isArray(roles) ? roles : [])
    .map((role) => String(role || '').trim())
    .filter((role) => isSupportedUserType(role));
  if (!allowed.length) return [];
  const users = await NewUser.find({
    UserType: { $in: allowed },
    Status: ACTIVE_STATUS,
  }).select('_id EmployeeName UserType Status').lean();
  return users
    .map((user) => ({
      id: String(user._id),
      name: user.EmployeeName || user.UserType,
      role: user.UserType,
    }))
    .sort((left, right) => {
      const byName = String(left.name).localeCompare(String(right.name));
      return byName || String(left.role).localeCompare(String(right.role));
    });
}

async function fileExists(storageKey) {
  const absolutePath = resolvePrivateDocumentPath(storageKey);
  const fs = require('fs');
  await fs.promises.access(absolutePath);
  return absolutePath;
}

async function notify(payload) {
  return createOfferWorkflowNotification(payload);
}

const CANDIDATE_STATUS_BY_OFFER_ACTION = {
  release_offer: 'Offer Released',
  mark_accepted: 'Offer Accepted',
  mark_declined: 'Candidate Declined',
  confirm_onboard: 'Onboard Confirmation',
  mark_joined: 'Joined',
};

/** Statuses HR can record directly that still belong to an offer workflow. */
const HR_MANUAL_OFFER_STATUSES = new Set(Object.values(CANDIDATE_STATUS_BY_OFFER_ACTION));

const FORWARD_APPLICATION_STATUS_RANK = {
  'Offer Released': 1,
  'Offer Accepted': 2,
  'Onboard Confirmation': 3,
  Joined: 4,
};

const CANDIDATE_SYNC_ATTEMPTS = 3;

const COMPLETED_OFFER_CANDIDATE_STATUS = Object.values(CANDIDATE_STATUS_BY_OFFER_ACTION)
  .reduce((statuses, status) => {
    statuses[status] = status;
    return statuses;
  }, {});

function shouldAppendCandidateStatus(latestStatus, nextStatus) {
  if (!nextStatus || latestStatus === nextStatus) return false;
  const latestRank = FORWARD_APPLICATION_STATUS_RANK[latestStatus];
  const nextRank = FORWARD_APPLICATION_STATUS_RANK[nextStatus];
  if (latestRank && nextRank && latestRank > nextRank) return false;
  return true;
}

function actorMayRetryCandidateSync(actor, offer, action) {
  if (CANDIDATE_STATUS_BY_OFFER_ACTION[action] !== offer?.currentStatus) return false;
  if (action === 'release_offer') return ['HR', 'Admin'].includes(actor?.role) && canReadOffer(actor, offer);
  if (!['Admin', 'HR', 'TeamLead'].includes(actor?.role)) return false;
  if (actor.role === 'TeamLead') return offer.responsibleTeamLeadUserId === actor.id;
  if (actor.role === 'Admin') return true;
  return canReadOffer(actor, offer);
}

async function appendCandidateApplicationStatus({
  candidateSubdocumentId,
  status,
  remark,
  actor,
}) {
  try {
    const result = await appendCandidateStatusHistory({
      candidateId: candidateSubdocumentId,
      status,
      remark,
      rejectionActorId: actor?.id || '',
      notificationActorId: actor?.id || '',
      actorName: actor?.name || '',
      preserveExistingRemarkWhenEmpty: true,
    });
    return { appended: true, status: result.status };
  } catch (error) {
    if (error instanceof CandidateStatusUpdateError && error.code === 'REMARK_REQUIRED') {
      throw new OfferWorkflowError(error.message, 400, 'COMMENTS_REQUIRED');
    }
    if (error instanceof CandidateStatusUpdateError && error.code === 'CANDIDATE_NOT_FOUND') {
      throw new OfferWorkflowError(error.message, 404, 'CANDIDATE_NOT_FOUND');
    }
    throw error;
  }
}

const defaultDeps = {
  isEnabled: isOfferWorkflowEnabled,
  prepare: prepareOfferStorage,
  loadActor,
  findCandidateContext,
  findCandidateIdsByLatestStatus,
  findLatestCandidateStatuses,
  findLatestCandidateStatusDetails,
  findOpenOffer,
  findLatestOfferForCandidate,
  findTeamLeadsForRecruiters,
  findActiveTeamLead,
  findActiveTeamLeadsForClient,
  findRequirement,
  findClient,
  allocateOfferNumber,
  insertOffer,
  conditionalUpdate,
  insertHistory,
  queryOffers,
  countOfferGroups,
  findOfferById,
  listOpenOffers,
  listClosedWorkflowOffers,
  listHistory,
  latestReturnComments,
  findActiveUsersByRole,
  findActiveUsersByRoles,
  fileExists,
  notify,
  appendCandidateStatus: appendCandidateApplicationStatus,
  createId: () => new mongoose.Types.ObjectId().toString(),
};

function cleanCorrelationId(value) {
  const raw = String(value || '').trim();
  if (!raw || !/^[A-Za-z0-9_.:-]{1,80}$/.test(raw)) return '';
  return raw;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPublicOffer(offer, actor) {
  const plain = clone(offer);
  plain.id = String(plain._id);
  if (Array.isArray(plain.documents)) {
    plain.documents = plain.documents.map((document) => {
      const copy = { ...document };
      delete copy.storageKey;
      return copy;
    });
  }
  delete plain.education;
  if (plain.employment && typeof plain.employment === 'object') {
    delete plain.employment.employmentType;
    delete plain.employment.offerType;
  }
  if (plain.client && typeof plain.client === 'object') {
    delete plain.client.projectDetails;
  }
  if (plain.sourceSnapshot && typeof plain.sourceSnapshot === 'object') {
    delete plain.sourceSnapshot.education;
    if (plain.sourceSnapshot.employment && typeof plain.sourceSnapshot.employment === 'object') {
      delete plain.sourceSnapshot.employment.employmentType;
      delete plain.sourceSnapshot.employment.offerType;
    }
    if (plain.sourceSnapshot.client && typeof plain.sourceSnapshot.client === 'object') {
      delete plain.sourceSnapshot.client.projectDetails;
    }
  }
  if (plain.letter) {
    const letter = { ...plain.letter };
    delete letter.storageKey;
    plain.letter = letter;
  }
  if (actor?.role !== 'HR' && actor?.role !== 'Admin') {
    delete plain.hasOtherExpenses;
    delete plain.otherExpenses;
    delete plain.commercialNotes;
    delete plain.internalRemarks;
  }
  plain.tlStageSkipped = isTlStageSkipped(plain);
  plain.workflowStage = offerWorkflowStageId(plain);
  plain.statusLabel = offerStatusDisplayLabel(plain.currentStatus);
  return plain;
}

function toSummary(offer, returnReason = '', latestCandidateStatus = '') {
  const first = offer.candidateSnapshot?.firstName || '';
  const last = offer.candidateSnapshot?.lastName || '';
  return {
    id: String(offer._id),
    offerRequestNumber: offer.offerRequestNumber,
    candidateSubdocumentId: offer.candidateSubdocumentId || '',
    isOpen: offer.isOpen !== false,
    candidateName: `${first} ${last}`.trim(),
    technologyOrRole: offer.employment?.proposedDesignation || offer.candidateSnapshot?.technicalSkills || '',
    clientName: offer.client?.clientName || '',
    responsibleTeamLeadUserId: offer.responsibleTeamLeadUserId || '',
    responsibleTeamLeadName: offer.responsibleTeamLeadName || '',
    initiatedAt: offer.createdAt || null,
    currentStatus: offer.currentStatus,
    currentAssigneeUserId: offer.currentAssigneeUserId || '',
    currentAssigneeRole: offer.currentAssigneeRole || '',
    currentAssigneeName: offer.currentAssigneeName || '',
    hrRemarks: String(offer.hrRemarks || '').trim(),
    letterPreparationSource: offer.letterPreparationSource || '',
    letterPreparationSubmittedByRole: offer.letterPreparationSubmittedByRole || '',
    letterPreparationSubmittedByName: offer.letterPreparationSubmittedByName || '',
    initiatedByUserId: offer.initiatedByUserId || '',
    initiatedByRole: offer.initiatedByRole || '',
    initiationRoute: offer.initiationRoute || '',
    tlStageSkipped: isTlStageSkipped(offer),
    workflowStage: offerWorkflowStageId(offer),
    statusLabel: offerStatusDisplayLabel(offer.currentStatus),
    latestCandidateStatus: String(latestCandidateStatus || '').trim(),
    updatedAt: offer.updatedAt || null,
    returnReason: String(returnReason || '').trim(),
  };
}

const OFFER_LIST_CANDIDATE_STATUSES = [
  'Offer to be released',
  'Offer Released',
  'Offer Accepted',
  'Onboard Confirmation',
  'Joined',
  'Candidate Declined',
];

function normalizeOfferListCandidateStatus(status) {
  return String(status || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const OFFER_LIST_CANDIDATE_STATUS_RANK = new Map(
  OFFER_LIST_CANDIDATE_STATUSES.map((status, index) => [normalizeOfferListCandidateStatus(status), index]),
);

function parseCandidateStatusFilter(query = {}) {
  const raw = String(query.candidateStatus || '').trim();
  if (!raw) return '';
  const key = normalizeOfferListCandidateStatus(raw);
  if (!OFFER_LIST_CANDIDATE_STATUS_RANK.has(key)) {
    throw new OfferWorkflowError('Unknown candidate status filter.', 400, 'INVALID_STATUS');
  }
  return key;
}

function readCandidateStatusDetail(value, offerUpdatedAt) {
  const fallback = offerUpdatedAt ? new Date(offerUpdatedAt).getTime() : 0;
  if (value && typeof value === 'object') {
    const statusTime = value.updatedAt ? new Date(value.updatedAt).getTime() : 0;
    return {
      status: String(value.status || '').trim(),
      updatedAt: Number.isFinite(statusTime) && statusTime > 0 ? statusTime : (Number.isFinite(fallback) ? fallback : 0),
    };
  }
  return {
    status: String(value || '').trim(),
    updatedAt: Number.isFinite(fallback) ? fallback : 0,
  };
}

function compareOfferListCandidates(leftOffer, leftDetail, rightOffer, rightDetail) {
  const unknownRank = OFFER_LIST_CANDIDATE_STATUSES.length;
  const leftRank = OFFER_LIST_CANDIDATE_STATUS_RANK.get(normalizeOfferListCandidateStatus(leftDetail.status));
  const rightRank = OFFER_LIST_CANDIDATE_STATUS_RANK.get(normalizeOfferListCandidateStatus(rightDetail.status));
  const rankDiff = (leftRank == null ? unknownRank : leftRank) - (rightRank == null ? unknownRank : rightRank);
  if (rankDiff !== 0) return rankDiff;
  const updatedDiff = (rightDetail.updatedAt || 0) - (leftDetail.updatedAt || 0);
  if (updatedDiff !== 0) return updatedDiff;
  return String(rightOffer._id || '').localeCompare(String(leftOffer._id || ''));
}

function parseStatusList(query = {}) {
  const raw = query.statuses != null && query.statuses !== '' ? query.statuses : query.status;
  if (raw == null || raw === '') return [];
  const values = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((item) => String(item).trim())
    .filter(Boolean);
  const unique = [...new Set(values)];
  unique.forEach((status) => {
    if (!OFFER_STATUSES.includes(status)) {
      throw new OfferWorkflowError('Unknown offer status filter.', 400, 'INVALID_STATUS');
    }
  });
  return unique;
}

function parsePage(query) {
  const page = Number(query.page == null || query.page === '' ? 1 : query.page);
  const limit = Number(query.limit == null || query.limit === '' ? 20 : query.limit);
  if (!Number.isInteger(page) || page < 1) {
    throw new OfferWorkflowError('Page must be a positive integer.', 400, 'INVALID_PAGE');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new OfferWorkflowError('Limit must be between 1 and 50.', 400, 'INVALID_PAGE');
  }
  return { page, limit };
}

function assertSaveReview(actor, offer) {
  if (!canReadOffer(actor, offer)) {
    throw new OfferWorkflowError('You do not have permission to update this offer request.', 403, 'OFFER_FORBIDDEN');
  }
  if (actor.role === 'HR') {
    const allowed = ['HR Review', 'Returned to HR'].includes(offer.currentStatus)
      || (offer.currentStatus === 'Returned by Admin' && offer.currentAssigneeRole === 'HR');
    if (!allowed) {
      throw new OfferWorkflowError('HR can save a review only while the request is with HR.', 409, 'INVALID_TRANSITION');
    }
    return;
  }
  if (actor.role === 'Admin') {
    return;
  }
  throw new OfferWorkflowError('You do not have permission to save this review.', 403, 'OFFER_FORBIDDEN');
}

function createOfferWorkflowService(deps = defaultDeps) {
  async function gate() {
    if (!deps.isEnabled()) {
      throw new OfferWorkflowError('Offer workflow is disabled.', 403, 'OFFER_WORKFLOW_DISABLED');
    }
    if (deps.prepare) await deps.prepare();
  }

  async function actorFrom(tokenUser) {
    return deps.loadActor(tokenUser);
  }

  async function writeHistory(entry) {
    try {
      return await deps.insertHistory(entry);
    } catch (firstError) {
      try {
        return await deps.insertHistory(entry);
      } catch (retryError) {
        logger.warn('Offer approval history write failed', {
          offerRequestId: entry.offerRequestId,
          action: entry.action,
          error: retryError.message,
        });
        throw new OfferWorkflowError(
          'The offer request was saved, but its approval history could not be recorded.',
          500,
          'HISTORY_WRITE_FAILED',
          { offerRequestId: entry.offerRequestId },
        );
      }
    }
  }

  async function remarkForCandidateSync(offer, status, comments) {
    const typed = String(comments || '').trim();
    if (typed || status !== 'Candidate Declined') return typed;
    const history = await deps.listHistory(offer._id);
    const recorded = [...(history || [])].reverse().find((entry) => (
      entry.newStatus === 'Candidate Declined' && String(entry.comments || '').trim()
    ));
    return recorded ? String(recorded.comments).trim() : '';
  }

  async function synchronizeCandidateStatus({ offer, status, remark, actor }) {
    const candidateSubdocumentId = String(offer.candidateSubdocumentId || '');
    if (!candidateSubdocumentId) {
      throw new OfferWorkflowError(
        'The offer request was updated, but the linked candidate could not be found.',
        409,
        'CANDIDATE_STATUS_SYNC_FAILED',
      );
    }
    const context = await deps.findCandidateContext(candidateSubdocumentId);
    if (!context?.candidate) {
      throw new OfferWorkflowError(
        'The offer request was updated, but the linked candidate could not be found.',
        404,
        'CANDIDATE_NOT_FOUND',
      );
    }
    const latestStatus = getOfferLatestCandidateStatus(context.candidate);
    if (!shouldAppendCandidateStatus(latestStatus, status)) {
      return { appended: false, status, latestStatus };
    }
    const syncRemark = await remarkForCandidateSync(offer, status, remark);
    if (status === 'Candidate Declined' && !syncRemark) {
      throw new OfferWorkflowError(
        'Remark is required when status is Candidate Declined.',
        400,
        'COMMENTS_REQUIRED',
      );
    }
    let lastError = null;
    for (let attempt = 1; attempt <= CANDIDATE_SYNC_ATTEMPTS; attempt += 1) {
      try {
        await deps.appendCandidateStatus({
          candidateSubdocumentId,
          status,
          remark: syncRemark,
          actor,
        });
        return { appended: true, status };
      } catch (error) {
        if (error?.code === 'COMMENTS_REQUIRED' || error?.code === 'CANDIDATE_NOT_FOUND') throw error;
        lastError = error;
      }
    }
    const afterFailure = await deps.findCandidateContext(candidateSubdocumentId);
    const afterStatus = getOfferLatestCandidateStatus(afterFailure?.candidate);
    if (!shouldAppendCandidateStatus(afterStatus, status)) {
      return { appended: false, status, latestStatus: afterStatus };
    }
    logger.warn('Candidate status synchronization failed', {
      offerRequestId: String(offer._id || ''),
      candidateSubdocumentId,
      status,
      error: lastError?.message || '',
    });
    throw new OfferWorkflowError(
      'The offer request was updated, but the candidate status could not be synchronized. Retry this action to finish the candidate update.',
      503,
      'CANDIDATE_STATUS_SYNC_FAILED',
      { offerStatus: offer.currentStatus, candidateStatus: status },
    );
  }

  async function reconcileCompletedOffer(offer) {
    const status = COMPLETED_OFFER_CANDIDATE_STATUS[offer?.currentStatus];
    if (!status) return { appended: false, skipped: true };
    return synchronizeCandidateStatus({
      offer,
      status,
      remark: '',
      actor: { id: offer.currentAssigneeUserId || '', role: offer.currentAssigneeRole || '', name: offer.currentAssigneeName || '' },
    });
  }

  async function reconcileCompletedOfferSafely(offer) {
    try {
      return await reconcileCompletedOffer(offer);
    } catch (error) {
      logger.warn('Completed offer candidate reconciliation failed', {
        offerRequestId: String(offer?._id || ''),
        offerRequestNumber: offer?.offerRequestNumber || '',
        status: offer?.currentStatus || '',
        error: error.message,
      });
      return { appended: false, failed: true };
    }
  }

  function notifiesAssignedTeamLead(decision) {
    const action = String(decision?.action || '');
    const assigneeRole = decision?.assignee?.role || '';
    if (action === 'assign_to_tl') return true;
    if (action === 'return_to_tl' || action === 'return_to_tl_by_md' || action === 'admin_return_to_tl') return true;
    if (action === 'admin_return' && (decision.returnTarget === 'tl' || assigneeRole === 'TeamLead')) return true;
    return assigneeRole === 'TeamLead'
      && ['Initiated', 'TL Review', 'Returned to TL', 'Returned to TL by MD', 'Returned by Admin'].includes(decision.to);
  }

  function assignedTeamLeadId(decision, offer) {
    if (decision?.assignee?.role === 'TeamLead' && decision.assignee.userId) return decision.assignee.userId;
    return String(offer?.responsibleTeamLeadUserId || '');
  }

  async function collectRecipientIds(decision, offer, actor) {
    const ids = new Set();
    const notifyTeamLead = notifiesAssignedTeamLead(decision);

    if (decision.action === 'cancel') {
      // Cancellation does not require Team Lead action.
    } else if (decision.action === 'release_offer') {
      if (offer.initiatedByRole === 'Admin' && offer.initiatedByUserId) ids.add(offer.initiatedByUserId);
      if (offer.adminApprovedByUserId) ids.add(offer.adminApprovedByUserId);
      if (offer.letterPreparationSubmittedByRole === 'Admin' && offer.letterPreparationSubmittedByUserId) {
        ids.add(offer.letterPreparationSubmittedByUserId);
      }
    } else if (POST_OFFER_ACTIONS.has(decision.action)) {
      if (actor.role !== 'HR') {
        const hrUsers = await deps.findActiveUsersByRole('HR');
        hrUsers.forEach((user) => ids.add(user.id));
      }
      if (actor.role !== 'Admin') {
        const admins = await deps.findActiveUsersByRole('Admin');
        admins.forEach((user) => ids.add(user.id));
      }
    } else {
      const audience = notificationAudience(decision);
      if (audience?.type === 'user' && audience.userId) {
        ids.add(audience.userId);
      } else if (audience?.type === 'role' && audience.role && audience.role !== 'TeamLead') {
        const users = await deps.findActiveUsersByRole(audience.role);
        users.forEach((user) => {
          if (user.id) ids.add(user.id);
        });
      }
    }

    const teamLeadId = assignedTeamLeadId(decision, offer);
    if (notifyTeamLead && teamLeadId) ids.add(teamLeadId);
    else if (teamLeadId) ids.delete(teamLeadId);
    ids.delete(actor.id);
    return [...ids];
  }

  async function notifyReviewers({ offer, decision, actor, history }) {
    const recipientIds = await collectRecipientIds(decision, offer, actor);
    if (!recipientIds.length || !history?._id) return { created: 0, duplicate: false };
    const sourceEventId = buildOfferSourceEventId(String(offer._id), String(history._id));
    const candidateName = `${offer.candidateSnapshot?.firstName || ''} ${offer.candidateSnapshot?.lastName || ''}`.trim();
    const clientName = String(offer.client?.clientName || '').trim() || 'Unknown client';
    const offerReleased = decision.action === 'release_offer';
    const verifiedForLetter = decision.action === 'request_letter_preparation'
      || decision.action === 'approve_and_send_for_release';
    const resentToHr = decision.action === 'resend_hr_generation_notice';
    const approvedForGeneration = decision.action === 'approve' && decision.to === 'Letter Preparation Requested';
    const returnAction = [
      'return_to_tl',
      'return_to_tl_by_md',
      'return_to_hr',
      'return_to_md',
      'admin_return',
    ].includes(decision.action);
    const returnTargetLabel = decision.returnTargetLabel
      || (decision.action === 'return_to_hr' ? 'HR'
        : decision.action === 'return_to_tl' || decision.action === 'return_to_tl_by_md' ? 'Team Lead'
          : decision.assignee?.role || decision.to);
    const title = verifiedForLetter || approvedForGeneration || resentToHr
      ? `Offer ${offer.offerRequestNumber} · Offer Generation`
      : returnAction
        ? `Offer ${offer.offerRequestNumber} · Returned to ${returnTargetLabel}`
        : `Offer ${offer.offerRequestNumber} · ${offerStatusDisplayLabel(decision.to) || decision.to}`;
    const sender = `${actor.name || actor.role} (${actor.role})`;
    const stageLabel = offerStatusDisplayLabel(decision.to) || decision.to;
    const message = offerReleased
      ? `Offer released successfully for ${candidateName} – ${offer.offerRequestNumber}.`
      : verifiedForLetter
      ? `${offer.offerRequestNumber} for ${candidateName} at ${clientName}: Admin instructed HR to generate the offer.`
      : resentToHr
        ? `${offer.offerRequestNumber} for ${candidateName} at ${clientName}: Admin resent the offer-generation instruction.`
      : approvedForGeneration
        ? `${offer.offerRequestNumber} for ${candidateName} at ${clientName} is approved and ready for offer generation.`
        : returnAction
          ? `${offer.offerRequestNumber} for ${candidateName} at ${clientName} was returned to ${returnTargetLabel}: ${decision.comments || ''}`
          : `${offer.offerRequestNumber} for ${candidateName} at ${clientName} is now ${stageLabel}.`;
    let created = 0;
    let duplicate = false;
    await Promise.all(recipientIds.map(async (recipientUserId) => {
      try {
        const result = await deps.notify({
          recipientUserId,
          title,
          message,
          link: `/offers/${offer._id}`,
          candidateId: offer.candidateSubdocumentId || '',
          requirementId: offer.requirementMongoId || offer.sourceReqId || '',
          actorUserId: actor.id,
          sourceEventId,
        });
        if (result?.created) created += 1;
        if (result?.duplicate) duplicate = true;
      } catch (error) {
        if (error && error.code === 11000) {
          duplicate = true;
          return;
        }
        logger.warn('Offer notification failed', {
          offerRequestId: String(offer._id),
          error: error.message,
        });
        throw error;
      }
    }));
    return { created, duplicate };
  }

  function initiationComment(actor, selection) {
    const actorLabel = actor.role === 'HR' ? 'HR' : 'Admin';
    if (selection.mode === 'admin_override_unassigned') {
      return `${actorLabel} selected a Team Lead because none is assigned to the recruiter.`;
    }
    if (selection.mode === 'admin_selected_hr' || selection.mode === 'selected_hr') {
      return `${actorLabel} selected an HR user as the responsible person.`;
    }
    return '';
  }

  function openOfferConflictDetails(existing, actor) {
    if (!existing) return null;
    return {
      offerId: String(existing._id || existing.id || ''),
      offerRequestNumber: existing.offerRequestNumber || '',
      currentStatus: existing.currentStatus || '',
      requirementBusinessId: existing.requirementBusinessId || existing.sourceReqId || '',
      canOpen: Boolean(actor && canReadOffer(actor, existing)),
    };
  }

  function openOfferIndicator(offer, actor) {
    const canOpen = Boolean(actor && canReadOffer(actor, offer));
    const candidateSubdocumentId = String(offer.candidateSubdocumentId || '');
    if (!canOpen) {
      return {
        candidateSubdocumentId,
        offerId: '',
        offerRequestNumber: '',
        currentStatus: '',
        statusLabel: '',
        initiatedAt: null,
        canOpen: false,
      };
    }
    return {
      candidateSubdocumentId,
      offerId: String(offer._id || offer.id || ''),
      offerRequestNumber: offer.offerRequestNumber || '',
      currentStatus: offer.currentStatus || '',
      currentAssigneeRole: offer.currentAssigneeRole || '',
      initiationRoute: offer.initiationRoute || '',
      tlStageSkipped: offer.tlStageSkipped === true,
      statusLabel: offerStatusDisplayLabel(offer.currentStatus),
      initiatedAt: offer.createdAt || null,
      canOpen: true,
    };
  }

  function hasDraftFields(draft) {
    if (!draft || typeof draft !== 'object') return false;
    return ['candidate', 'employment', 'client', 'commercial', 'additionalRemarks'].some((key) => {
      const value = draft[key];
      if (value == null) return false;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return String(value).trim() !== '';
    });
  }

  async function assignedClientId(candidateSubdocumentId) {
    if (!isMongoIdString(candidateSubdocumentId)) return '';
    const context = await deps.findCandidateContext(candidateSubdocumentId);
    if (!context?.main) return '';
    const requirement = await deps.findRequirement(context.main.reqId);
    if (!requirement) return '';
    const client = await deps.findClient(requirement);
    const resolvedId = client?._id ? String(client._id) : '';
    if (isMongoIdString(resolvedId)) return resolvedId;
    const rawId = String(requirement.clientId || '').trim();
    return isMongoIdString(rawId) ? rawId : '';
  }

  async function listInitiationRecipients({ tokenUser, candidateSubdocumentId }) {
    await gate();
    const actor = await actorFrom(tokenUser);
    if (actor.role !== 'Admin' && actor.role !== 'HR') {
      throw new OfferWorkflowError('Only Admin or HR can list offer recipients.', 403, 'OFFER_FORBIDDEN');
    }
    const recipients = (await deps.findActiveUsersByRoles(['TeamLead', 'HR'])).filter((person) => person.id);
    let defaultRecipientUserId = '';
    const clientId = await assignedClientId(candidateSubdocumentId);
    if (clientId && typeof deps.findActiveTeamLeadsForClient === 'function') {
      const leads = await deps.findActiveTeamLeadsForClient(clientId);
      const activeLeads = (leads || []).filter((lead) => (
        lead
        && lead.active !== false
        && lead.role === 'TeamLead'
        && recipients.some((person) => person.id === lead.id && person.role === 'TeamLead')
      ));
      if (activeLeads.length === 1) defaultRecipientUserId = activeLeads[0].id;
    }
    return { recipients, defaultRecipientUserId };
  }

  async function initiateOffer({ tokenUser, candidateSubdocumentId, recipientUserId, teamLeadUserId, initiationRoute: _ignoredClientRoute, correlationId, draft }) {
    await gate();
    const actor = await actorFrom(tokenUser);
    if (actor.role !== 'Admin' && actor.role !== 'HR') {
      throw new OfferWorkflowError('Only Admin or HR can initiate an offer request.', 403, 'OFFER_FORBIDDEN');
    }
    if (!isMongoIdString(candidateSubdocumentId)) {
      throw new OfferWorkflowError('A valid candidate id is required.', 400, 'INVALID_CANDIDATE');
    }

    const context = await deps.findCandidateContext(candidateSubdocumentId);
    if (!context?.candidate) {
      throw new OfferWorkflowError('Candidate not found.', 404, 'CANDIDATE_NOT_FOUND');
    }
    assertInitiationStatus(context.candidate);

    const existing = await deps.findOpenOffer(String(context.candidate._id));
    if (existing) {
      throw new OfferWorkflowError(
        'An active offer request already exists for this candidate and requirement.',
        409,
        'OPEN_OFFER_EXISTS',
        openOfferConflictDetails(existing, actor),
      );
    }

    const recruiterUserIds = collectRecruiterIds(context.candidate, context.main);
    const recruiterUserId = primaryRecruiterId(context.candidate, context.main);
    if (!recruiterUserId) {
      throw new OfferWorkflowError(
        'This candidate has no recruiter, so a Team Lead cannot be resolved.',
        422,
        'RECRUITER_MISSING',
      );
    }

    const recipientId = normalizeId(recipientUserId || teamLeadUserId);
    if (!isMongoIdString(recipientId)) {
      throw new OfferWorkflowError('Select a recipient.', 400, 'RECIPIENT_REQUIRED');
    }
    const recipient = await deps.findActiveTeamLead(recipientId);
    if (!recipient || recipient.active !== true) {
      throw new OfferWorkflowError('Selected recipient was not found or is inactive.', 422, 'INVALID_RECIPIENT');
    }
    if (!['TeamLead', 'HR'].includes(recipient.role)) {
      throw new OfferWorkflowError('Select an active Team Lead or HR user.', 422, 'INVALID_RECIPIENT');
    }

    const associatedTeamLeads = await deps.findTeamLeadsForRecruiters(recruiterUserIds);
    const associated = associatedTeamLeads.filter((lead) => lead && lead.id);
    const skipTl = recipient.role === 'HR';
    const responsibleLead = skipTl
      ? (associated[0] || { id: '', name: '', role: 'TeamLead' })
      : recipient;
    const associatedMatch = associated.find((lead) => lead.id === recipient.id);
    const selection = {
      ok: true,
      teamLead: responsibleLead,
      mode: skipTl
        ? 'selected_hr'
        : associatedMatch
          ? (associated.length === 1 ? 'single_assigned' : 'selected_associated')
          : 'admin_override_unassigned',
    };

    const initialStatus = skipTl ? 'HR Review' : 'Initiated';
    const assigneeRole = skipTl ? 'HR' : 'TeamLead';
    const assigneeUserId = recipient.id;
    const assigneeName = recipient.name || assigneeRole;
    const initiationRouteValue = skipTl ? 'DIRECT_TO_HR' : 'TL_REVIEW';

    const requirement = await deps.findRequirement(context.main.reqId);
    const client = await deps.findClient(requirement);
    const candidateSnapshot = buildCandidateSnapshot(context.candidate);
    const employment = buildEmploymentSeed(context.candidate, requirement);
    const clientSection = buildClientSeed(requirement, client);
    let commercial = { ...emptyCommercials(), commercialRemarks: '' };
    let additionalRemarks = '';
    if (hasDraftFields(draft)) {
      const patched = applyDraftPatch({
        candidateSnapshot,
        employment,
        client: clientSection,
        commercial,
        additionalRemarks: '',
      }, draft);
      Object.assign(candidateSnapshot, patched.candidateSnapshot || {});
      Object.assign(employment, patched.employment || {});
      Object.assign(clientSection, patched.client || {});
      commercial = patched.commercial || commercial;
      additionalRemarks = patched.additionalRemarks || '';
    }
    const now = new Date();
    const offerRequestNumber = await deps.allocateOfferNumber(now);
    const correlation = cleanCorrelationId(correlationId);

    const sourceSnapshot = {
      capturedAt: now.toISOString(),
      candidate: clone(candidateSnapshot),
      employment: clone(employment),
      client: clone(clientSection),
      requirement: requirement ? {
        mongoId: String(requirement._id),
        businessId: requirement.regId == null ? '' : String(requirement.regId),
        role: requirement.role || '',
        skill: requirement.skill || '',
        clientName: requirement.client || '',
        clientId: requirement.clientId == null ? '' : String(requirement.clientId),
      } : null,
    };

    let created;
    try {
      created = await deps.insertOffer({
        offerRequestNumber,
        candidateDocumentId: context.main._id,
        candidateSubdocumentId: String(context.candidate._id),
        sourceReqId: context.main.reqId || '',
        requirementMongoId: requirement?._id ? String(requirement._id) : '',
        requirementBusinessId: requirement?.regId == null ? '' : String(requirement.regId || ''),
        recruiterUserId,
        recruiterUserIds,
        initiatedByUserId: actor.id,
        initiatedByRole: actor.role || 'Admin',
        responsibleTeamLeadUserId: selection.teamLead.id || '',
        responsibleTeamLeadName: selection.teamLead.name || '',
        responsibleHrUserId: skipTl ? recipient.id : '',
        responsibleHrName: skipTl ? (recipient.name || 'HR') : '',
        teamLeadSelectionMode: selection.mode,
        initiationRoute: initiationRouteValue,
        tlStageSkipped: skipTl,
        currentAssigneeUserId: assigneeUserId,
        currentAssigneeRole: assigneeRole,
        currentAssigneeName: assigneeName,
        currentStatus: initialStatus,
        isOpen: true,
        workflowVersion: 0,
        sourceSnapshot,
        candidateSnapshot,
        employment,
        client: clientSection,
        commercial,
        documents: [],
        additionalRemarks,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (error && error.code === 11000) {
        const key = String(error.message || '');
        if (key.includes('offerRequestNumber')) {
          throw new OfferWorkflowError(
            'Could not allocate a unique offer request number. Retry initiation.',
            409,
            'OFFER_NUMBER_CONFLICT',
          );
        }
        const duplicate = await deps.findOpenOffer(String(context.candidate._id));
        throw new OfferWorkflowError(
          'An active offer request already exists for this candidate and requirement.',
          409,
          'OPEN_OFFER_EXISTS',
          openOfferConflictDetails(duplicate, actor),
        );
      }
      throw error;
    }

    await writeHistory({
      offerRequestId: String(created._id),
      action: 'initiate',
      previousStatus: '',
      newStatus: initialStatus,
      actorUserId: actor.id,
      actorRole: actor.role,
      comments: skipTl
        ? `${actor.role} initiated the offer directly to ${assigneeName} (HR).`
        : initiationComment(actor, selection),
      correlationId: correlation,
    });

    const assignAction = skipTl ? 'assign_to_hr' : 'assign_to_tl';
    const assignHistory = await writeHistory({
      offerRequestId: String(created._id),
      action: assignAction,
      previousStatus: initialStatus,
      newStatus: initialStatus,
      actorUserId: actor.id,
      actorRole: actor.role,
      comments: '',
      correlationId: correlation,
    });

    let warning = '';
    try {
      await notifyReviewers({
        offer: created,
        decision: {
          ok: true,
          action: assignAction,
          to: initialStatus,
          assignee: {
            userId: assigneeUserId,
            role: assigneeRole,
            name: assigneeName,
          },
        },
        actor,
        history: assignHistory,
      });
    } catch (error) {
      warning = skipTl
        ? 'The offer request was assigned, but the HR notification could not be sent.'
        : 'The offer request was assigned, but the Team Lead notification could not be sent.';
    }

    const canOpen = canReadOffer(actor, created);
    return {
      offer: canOpen ? toPublicOffer(created, actor) : {
        offerRequestNumber: created.offerRequestNumber || '',
        candidateSubdocumentId: String(created.candidateSubdocumentId || ''),
        currentStatus: created.currentStatus || '',
        currentAssigneeRole: created.currentAssigneeRole || '',
      },
      warning,
      canOpen,
    };
  }

  async function listOpenOfferIndicators({ tokenUser }) {
    await gate();
    const actor = await actorFrom(tokenUser);
    if (actor.role !== 'Admin' && actor.role !== 'HR') {
      throw new OfferWorkflowError('Only Admin or HR can look up open offer requests.', 403, 'OFFER_FORBIDDEN');
    }
    const offers = typeof deps.listOpenOffers === 'function' ? await deps.listOpenOffers() : [];
    const openOffers = (offers || [])
      .filter((offer) => offer && offer.isOpen !== false && offer.candidateSubdocumentId);
    const seenCandidates = new Set(openOffers.map((offer) => String(offer.candidateSubdocumentId)));
    const closedOffers = typeof deps.listClosedWorkflowOffers === 'function'
      ? await deps.listClosedWorkflowOffers()
      : [];
    const visibleClosedOffers = [];
    (closedOffers || []).forEach((offer) => {
      const candidateId = String(offer?.candidateSubdocumentId || '');
      if (!candidateId || seenCandidates.has(candidateId)) return;
      if (!['Joined', 'Candidate Declined'].includes(offer.currentStatus)) return;
      seenCandidates.add(candidateId);
      visibleClosedOffers.push(offer);
    });
    let repairedOffers = [];
    if (actor.role === 'HR') {
      try {
        repairedOffers = await ensureMissingHrManualOffers({ tokenUser, seenCandidates });
      } catch (error) {
        logger.warn('HR follow-up offer lookup failed', { error: error.message });
      }
    }
    return [...openOffers, ...visibleClosedOffers, ...repairedOffers]
      .map((offer) => openOfferIndicator(offer, actor));
  }

  async function ensureMissingHrManualOffers({ tokenUser, seenCandidates }) {
    if (typeof deps.findCandidateIdsByLatestStatus !== 'function') return [];
    if (typeof deps.findLatestCandidateStatuses !== 'function') return [];
    if (typeof deps.findOfferById !== 'function') return [];
    let candidateIds = [];
    try {
      candidateIds = await deps.findCandidateIdsByLatestStatus(
        /^(Offer Released|Offer Accepted|Onboard Confirmation|Joined|Candidate Declined)$/,
      );
    } catch (error) {
      logger.warn('HR follow-up offer lookup failed', { error: error.message });
      return [];
    }
    const pendingIds = [...new Set((candidateIds || []).map((id) => String(id || '')).filter(Boolean))]
      .filter((id) => !seenCandidates.has(id));
    if (!pendingIds.length) return [];
    let statuses;
    try {
      statuses = await deps.findLatestCandidateStatuses(pendingIds);
    } catch (error) {
      logger.warn('HR follow-up offer lookup failed', { error: error.message });
      return [];
    }
    const repaired = [];
    for (const candidateId of pendingIds) {
      const status = statuses.get(candidateId) || '';
      if (!HR_MANUAL_OFFER_STATUSES.has(status)) continue;
      try {
        const ensured = await ensureOfferForHrManualStatus({
          tokenUser,
          candidateSubdocumentId: candidateId,
          status,
        });
        if (!ensured?.offerId) continue;
        const offer = await deps.findOfferById(ensured.offerId);
        const offerCandidateId = String(offer?.candidateSubdocumentId || '');
        if (!offer || !offerCandidateId || seenCandidates.has(offerCandidateId)) continue;
        if (offer.currentStatus === 'Cancelled') continue;
        if (offer.isOpen === false && !['Joined', 'Candidate Declined'].includes(offer.currentStatus)) continue;
        seenCandidates.add(offerCandidateId);
        repaired.push(offer);
      } catch (error) {
        logger.warn('HR follow-up offer could not be ensured', {
          candidateSubdocumentId: candidateId,
          error: error.message,
        });
      }
    }
    return repaired;
  }

  function offerIdOf(offer) {
    return String(offer?._id || offer?.id || '');
  }

  /**
   * HR can record an offer-workflow status without using the offer actions.
   * Reuse this candidate's offer when one exists. Create one only when the
   * status belongs to the offer workflow and no offer exists yet.
   */
  async function ensureOfferForHrManualStatus({ tokenUser, candidateSubdocumentId, status } = {}) {
    const nextStatus = String(status || '').trim();
    if (!HR_MANUAL_OFFER_STATUSES.has(nextStatus)) return null;
    if (tokenUser?.role !== 'HR') return null;
    if (!deps.isEnabled()) return null;
    await gate();
    const actor = await actorFrom(tokenUser);
    if (actor.role !== 'HR') return null;

    const candidateId = String(candidateSubdocumentId || '').trim();
    if (!isMongoIdString(candidateId)) return null;

    const openOffer = await deps.findOpenOffer(candidateId);
    if (openOffer) return { offerId: offerIdOf(openOffer), created: false };

    const latest = typeof deps.findLatestOfferForCandidate === 'function'
      ? await deps.findLatestOfferForCandidate(candidateId)
      : null;
    if (latest && latest.isOpen !== false) {
      return { offerId: offerIdOf(latest), created: false };
    }
    if (latest && latest.currentStatus === nextStatus) {
      return { offerId: offerIdOf(latest), created: false };
    }
    if (latest && !isOpenOfferStatus(nextStatus)) {
      const updated = await deps.conditionalUpdate(
        latest._id || latest.id,
        latest.currentStatus,
        latest.workflowVersion || 0,
        {
          currentStatus: nextStatus,
          isOpen: false,
          currentAssigneeUserId: actor.id,
          currentAssigneeRole: 'HR',
          currentAssigneeName: actor.name || 'HR',
          responsibleHrUserId: actor.id,
          responsibleHrName: actor.name || 'HR',
        },
      );
      return { offerId: offerIdOf(updated || latest), created: false };
    }

    const context = await deps.findCandidateContext(candidateId);
    if (!context?.candidate) return null;
    const recruiterUserIds = collectRecruiterIds(context.candidate, context.main);
    const recruiterUserId = primaryRecruiterId(context.candidate, context.main) || actor.id;
    const requirement = await deps.findRequirement(context.main.reqId);
    const client = await deps.findClient(requirement);
    const candidateSnapshot = buildCandidateSnapshot(context.candidate);
    const employment = buildEmploymentSeed(context.candidate, requirement);
    const clientSection = buildClientSeed(requirement, client);
    const now = new Date();
    const offerRequestNumber = await deps.allocateOfferNumber(now);
    let created;
    try {
      created = await deps.insertOffer({
      offerRequestNumber,
      candidateDocumentId: context.main._id,
      candidateSubdocumentId: candidateId,
      sourceReqId: context.main.reqId || '',
      requirementMongoId: requirement?._id ? String(requirement._id) : '',
      requirementBusinessId: requirement?.regId == null ? '' : String(requirement.regId || ''),
      recruiterUserId,
      recruiterUserIds,
      initiatedByUserId: actor.id,
      initiatedByRole: 'HR',
      responsibleTeamLeadUserId: '',
      responsibleTeamLeadName: '',
      responsibleHrUserId: actor.id,
      responsibleHrName: actor.name || 'HR',
      teamLeadSelectionMode: 'direct_hr_skip',
      initiationRoute: 'DIRECT_TO_HR',
      tlStageSkipped: true,
      currentAssigneeUserId: actor.id,
      currentAssigneeRole: 'HR',
      currentAssigneeName: actor.name || 'HR',
      currentStatus: nextStatus,
      isOpen: isOpenOfferStatus(nextStatus),
      workflowVersion: 0,
      sourceSnapshot: {
        capturedAt: now.toISOString(),
        candidate: clone(candidateSnapshot),
        employment: clone(employment),
        client: clone(clientSection),
      },
      candidateSnapshot,
      employment,
      client: clientSection,
      commercial: { ...emptyCommercials(), commercialRemarks: '' },
      documents: [],
      additionalRemarks: '',
      releasedAt: nextStatus === 'Offer Released' ? now : null,
      releasedByUserId: nextStatus === 'Offer Released' ? actor.id : '',
      createdAt: now,
      updatedAt: now,
    });
    } catch (error) {
      if (error && error.code === 11000) {
        const existing = await deps.findOpenOffer(candidateId)
          || (typeof deps.findLatestOfferForCandidate === 'function'
            ? await deps.findLatestOfferForCandidate(candidateId)
            : null);
        if (existing) return { offerId: offerIdOf(existing), created: false };
      }
      throw error;
    }
    try {
      await writeHistory({
        offerRequestId: String(created._id || created.id),
        action: 'manual_status_recorded',
        previousStatus: '',
        newStatus: nextStatus,
        actorUserId: actor.id,
        actorRole: 'HR',
        comments: `HR recorded candidate status ${nextStatus}.`,
        correlationId: '',
      });
    } catch (error) {
      logger.warn('Manual HR status offer was saved, but its history could not be recorded', {
        offerRequestId: String(created._id || created.id || ''),
        error: error.message,
      });
    }
    return { offerId: offerIdOf(created), created: true };
  }

  async function listOffers({ tokenUser, query = {} }) {
    await gate();
    const actor = await actorFrom(tokenUser);
    if (!['Admin', 'TeamLead', 'HR'].includes(actor.role)) {
      throw new OfferWorkflowError('You do not have permission to view offer requests.', 403, 'OFFER_FORBIDDEN');
    }
    const { page, limit } = parsePage(query);
    const statuses = parseStatusList(query);
    const returnedAssigneeRole = String(query.returnedAssigneeRole || '').trim();
    if (returnedAssigneeRole && !['Admin', 'TeamLead', 'HR'].includes(returnedAssigneeRole)) {
      throw new OfferWorkflowError('Unknown assignee role filter.', 400, 'INVALID_ASSIGNEE');
    }
    const letterPreparationSource = String(query.letterPreparationSource || '').trim();
    if (letterPreparationSource && !['admin', 'md'].includes(letterPreparationSource)) {
      throw new OfferWorkflowError('Unknown letter preparation source filter.', 400, 'INVALID_FIELD');
    }
    const searchText = String(query.q || query.search || '').trim().slice(0, 80);
    const filters = {};
    if (statuses.length) filters.statuses = statuses;
    if (returnedAssigneeRole) filters.returnedAssigneeRole = returnedAssigneeRole;
    if (letterPreparationSource) filters.letterPreparationSource = letterPreparationSource;
    if (searchText) {
      const pattern = new RegExp(escapeRegex(searchText), 'i');
      filters.search = [
        { offerRequestNumber: pattern },
        { 'candidateSnapshot.firstName': pattern },
        { 'candidateSnapshot.lastName': pattern },
        { 'candidateSnapshot.technicalSkills': pattern },
        { 'employment.proposedDesignation': pattern },
        { 'client.clientName': pattern },
      ];
      if (actor.role === 'HR') {
        filters.search.push({ currentStatus: pattern });
        if (typeof deps.findCandidateIdsByLatestStatus === 'function') {
          const statusMatches = await deps.findCandidateIdsByLatestStatus(pattern);
          if (statusMatches.length) {
            filters.search.push({ candidateSubdocumentId: { $in: statusMatches } });
          }
        }
      }
    }
    const filter = buildOfferListFilter(actor, filters);
    const createdAt = initiatedCreatedAtClause(query);
    applyCreatedAtClause(filter, createdAt);
    const orderByCandidateStatus = actor.role === 'Admin' || actor.role === 'HR';
    const candidateStatusFilter = orderByCandidateStatus ? parseCandidateStatusFilter(query) : '';

    const queried = await deps.queryOffers(
      filter,
      page,
      limit,
      orderByCandidateStatus ? { all: true } : undefined,
    );
    let items = (queried.items || []).filter((offer) => canReadOffer(actor, offer));
    const candidateIds = items.map((offer) => offer.candidateSubdocumentId);
    const statusDetails = orderByCandidateStatus && typeof deps.findLatestCandidateStatusDetails === 'function'
      ? await deps.findLatestCandidateStatusDetails(candidateIds)
      : null;
    const candidateStatuses = statusDetails
      ? new Map([...statusDetails.entries()].map(([id, detail]) => [id, readCandidateStatusDetail(detail).status]))
      : (typeof deps.findLatestCandidateStatuses === 'function'
        ? await deps.findLatestCandidateStatuses(candidateIds)
        : new Map());
    const detailFor = (offer) => {
      const id = String(offer.candidateSubdocumentId || '');
      if (statusDetails && statusDetails.has(id)) {
        return readCandidateStatusDetail(statusDetails.get(id), offer.updatedAt);
      }
      return readCandidateStatusDetail(candidateStatuses.get(id), offer.updatedAt);
    };
    let total = queried.total;
    if (orderByCandidateStatus) {
      if (candidateStatusFilter) {
        items = items.filter((offer) => (
          normalizeOfferListCandidateStatus(detailFor(offer).status) === candidateStatusFilter
        ));
      }
      items.sort((left, right) => compareOfferListCandidates(left, detailFor(left), right, detailFor(right)));
      total = items.length;
      const start = (page - 1) * limit;
      items = items.slice(start, start + limit);
    }
    for (const offer of items) {
      await reconcileCompletedOfferSafely(offer);
    }
    const countFilter = buildOfferListFilter(actor, searchText ? { search: filters.search } : {});
    applyCreatedAtClause(countFilter, createdAt);
    const counts = typeof deps.countOfferGroups === 'function'
      ? await deps.countOfferGroups(countFilter)
      : [];
    const returnReasons = typeof deps.latestReturnComments === 'function'
      ? await deps.latestReturnComments(items.map((offer) => offer._id))
      : new Map();
    return {
      items: items.map((offer) => toSummary(
        offer,
        returnReasons.get(String(offer._id)) || '',
        candidateStatuses.get(String(offer.candidateSubdocumentId || '')) || '',
      )),
      page,
      limit,
      total,
      counts,
    };
  }

  async function getOffer({ tokenUser, offerId }) {
    await gate();
    const actor = await actorFrom(tokenUser);
    const offer = await deps.findOfferById(offerId);
    if (!offer) throw new OfferWorkflowError('Offer request not found.', 404, 'OFFER_NOT_FOUND');
    if (!canReadOffer(actor, offer)) {
      throw new OfferWorkflowError('You do not have permission to view this offer request.', 403, 'OFFER_FORBIDDEN');
    }
    await reconcileCompletedOfferSafely(offer);
    const history = deps.listHistory ? await deps.listHistory(String(offer._id)) : [];
    return { offer: toPublicOffer(offer, actor), history };
  }

  async function saveDraft({ tokenUser, offerId, payload }) {
    await gate();
    const actor = await actorFrom(tokenUser);
    const offer = await deps.findOfferById(offerId);
    if (!offer) throw new OfferWorkflowError('Offer request not found.', 404, 'OFFER_NOT_FOUND');
    if (!canEditOfferDetails(actor, offer)) {
      throw new OfferWorkflowError('You cannot edit this offer request.', 403, 'OFFER_FORBIDDEN');
    }
    const draftPayload = payload || {};
    const touchesConfidential = ['hasOtherExpenses', 'otherExpenses', 'commercialNotes', 'internalRemarks']
      .some((field) => Object.prototype.hasOwnProperty.call(draftPayload, field));
    if (touchesConfidential && actor.role !== 'HR' && actor.role !== 'Admin') {
      throw new OfferWorkflowError(
        'Only HR or Admin can update other expenses and internal billing notes.',
        403,
        'OFFER_FORBIDDEN',
      );
    }
    const next = applyDraftPatch(offer, draftPayload);
    const allowIncompleteDraft = actor.role === 'TeamLead'
      || actor.role === 'HR'
      || actor.role === 'Admin';
    if (!allowIncompleteDraft) {
      const validation = validateOfferForSubmission(next);
      if (!validation.ok) {
        throw new OfferWorkflowError(validation.errors[0], 400, 'INVALID_FIELD');
      }
    }
    const setFields = {
      candidateSnapshot: next.candidateSnapshot,
      employment: next.employment,
      client: next.client,
      commercial: next.commercial,
      additionalRemarks: next.additionalRemarks || '',
      hasOtherExpenses: next.hasOtherExpenses === true || (
        next.hasOtherExpenses !== false
        && Array.isArray(next.otherExpenses)
        && next.otherExpenses.length > 0
      ),
      otherExpenses: Array.isArray(next.otherExpenses) ? next.otherExpenses : (offer.otherExpenses || []),
      commercialNotes: next.commercialNotes != null ? next.commercialNotes : (offer.commercialNotes || ''),
      internalRemarks: next.internalRemarks != null ? next.internalRemarks : (offer.internalRemarks || ''),
    };
    const startsTeamLeadReview = actor.role === 'TeamLead' && offer.currentStatus === 'Initiated';
    if (startsTeamLeadReview) setFields.currentStatus = 'TL Review';
    const updated = await deps.conditionalUpdate(offer._id, offer.currentStatus, offer.workflowVersion || 0, setFields);
    if (!updated) {
      throw new OfferWorkflowError(
        'This offer request was updated by someone else. Refresh and try again.',
        409,
        'OFFER_CONFLICT',
      );
    }
    if (startsTeamLeadReview) {
      await writeHistory({
        offerRequestId: String(updated._id),
        action: 'save_draft',
        previousStatus: 'Initiated',
        newStatus: 'TL Review',
        actorUserId: actor.id,
        actorRole: actor.role,
        comments: '',
        correlationId: '',
      });
    }
    return { offer: toPublicOffer(updated, actor) };
  }

  async function assertDocumentUploadAllowed({ tokenUser, offerId }) {
    await gate();
    const actor = await actorFrom(tokenUser);
    const offer = await deps.findOfferById(offerId);
    if (!offer) throw new OfferWorkflowError('Offer request not found.', 404, 'OFFER_NOT_FOUND');
    if (!canUploadDocuments(actor, offer)) {
      throw new OfferWorkflowError('You cannot upload documents for this offer request.', 403, 'OFFER_FORBIDDEN');
    }
    return { actor, offer };
  }

  async function attachDocument({ tokenUser, offerId, documentType, remarks, file }) {
    const { actor, offer } = await assertDocumentUploadAllowed({ tokenUser, offerId });
    assertDocumentType(documentType);
    if (!file?.storageKey) {
      throw new OfferWorkflowError('A document file is required.', 400, 'FILE_REQUIRED');
    }
    resolvePrivateDocumentPath(file.storageKey);
    const document = {
      _id: deps.createId(),
      documentType,
      originalFilename: sanitizeOriginalFilename(file.originalFilename),
      storageKey: file.storageKey,
      mimeType: file.mimeType || '',
      size: file.size || 0,
      uploadedByUserId: actor.id,
      uploadedAt: new Date(),
      verificationStatus: 'Pending',
      verificationComments: '',
      remarks: String(remarks || '').trim().slice(0, 1000),
    };
    const documents = [...(offer.documents || []), document];
    const updated = await deps.conditionalUpdate(offer._id, offer.currentStatus, offer.workflowVersion || 0, {
      documents,
    });
    if (!updated) {
      throw new OfferWorkflowError(
        'This offer request was updated by someone else. Refresh and try again.',
        409,
        'OFFER_CONFLICT',
      );
    }
    await writeHistory({
      offerRequestId: String(updated._id),
      action: 'upload_document',
      previousStatus: offer.currentStatus,
      newStatus: offer.currentStatus,
      actorUserId: actor.id,
      actorRole: actor.role,
      comments: documentType,
      correlationId: '',
    });
    return { offer: toPublicOffer(updated, actor) };
  }

  async function removeDocument({ tokenUser, offerId, documentId }) {
    await gate();
    const actor = await actorFrom(tokenUser);
    const offer = await deps.findOfferById(offerId);
    if (!offer) throw new OfferWorkflowError('Offer request not found.', 404, 'OFFER_NOT_FOUND');
    if (!canUploadDocuments(actor, offer)) {
      throw new OfferWorkflowError('You cannot delete documents for this offer request.', 403, 'OFFER_FORBIDDEN');
    }
    const document = (offer.documents || []).find((item) => String(item._id) === String(documentId));
    if (!document) throw new OfferWorkflowError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
    const documents = (offer.documents || []).filter((item) => String(item._id) !== String(documentId));
    const updated = await deps.conditionalUpdate(offer._id, offer.currentStatus, offer.workflowVersion || 0, {
      documents,
    });
    if (!updated) {
      throw new OfferWorkflowError(
        'This offer request was updated by someone else. Refresh and try again.',
        409,
        'OFFER_CONFLICT',
      );
    }
    try {
      const absolutePath = await deps.fileExists(document.storageKey);
      if (typeof deps.unlinkDocument === 'function') await deps.unlinkDocument(absolutePath);
    } catch (error) {
      if (!(error && error.isOfferWorkflowError)) {
        // The stored file is already gone. The document record is still removed.
      }
    }
    await writeHistory({
      offerRequestId: String(updated._id),
      action: 'delete_document',
      previousStatus: offer.currentStatus,
      newStatus: offer.currentStatus,
      actorUserId: actor.id,
      actorRole: actor.role,
      comments: document.documentType,
      correlationId: '',
    });
    return { offer: toPublicOffer(updated, actor) };
  }

  async function resolveDownload({ tokenUser, offerId, documentId }) {
    await gate();
    const actor = await actorFrom(tokenUser);
    const offer = await deps.findOfferById(offerId);
    if (!offer) throw new OfferWorkflowError('Offer request not found.', 404, 'OFFER_NOT_FOUND');
    if (!canReadOffer(actor, offer)) {
      throw new OfferWorkflowError('You do not have permission to download this document.', 403, 'OFFER_FORBIDDEN');
    }
    const document = (offer.documents || []).find((item) => String(item._id) === String(documentId));
    if (!document) throw new OfferWorkflowError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
    let absolutePath;
    try {
      absolutePath = await deps.fileExists(document.storageKey);
    } catch (error) {
      if (error && error.isOfferWorkflowError) throw error;
      throw new OfferWorkflowError('Document file is not available.', 404, 'DOCUMENT_NOT_FOUND');
    }
    return {
      absolutePath,
      originalFilename: sanitizeOriginalFilename(document.originalFilename),
      mimeType: document.mimeType || 'application/octet-stream',
    };
  }

  async function applyTransition({
    tokenUser,
    offerId,
    action,
    comments,
    returnTarget,
    documentVerifications,
    hrRemarks,
    correlationId,
  }) {
    await gate();
    const actor = await actorFrom(tokenUser);
    const offer = await deps.findOfferById(offerId);
    if (!offer) throw new OfferWorkflowError('Offer request not found.', 404, 'OFFER_NOT_FOUND');

    if (actorMayRetryCandidateSync(actor, offer, action)) {
      const recovered = await synchronizeCandidateStatus({
        offer,
        status: offer.currentStatus,
        remark: comments,
        actor,
      });
      if (recovered.appended) {
        return {
          offer: toPublicOffer(offer, actor),
          message: 'Candidate application status synchronized.',
        };
      }
    }

    if (action === 'resend_hr_generation_notice') {
      if (actor.role !== 'Admin') {
        throw new OfferWorkflowError('Only Admin can resend the HR generation instruction.', 403, 'OFFER_FORBIDDEN');
      }
      if (offer.currentStatus !== 'Letter Preparation Requested') {
        throw new OfferWorkflowError(
          'Resend is only available when the request is already with HR for offer generation.',
          409,
          'INVALID_TRANSITION',
        );
      }
      const history = await writeHistory({
        offerRequestId: String(offer._id),
        action: 'resend_hr_generation_notice',
        previousStatus: offer.currentStatus,
        newStatus: offer.currentStatus,
        actorUserId: actor.id,
        actorRole: actor.role,
        comments: String(comments || '').trim().slice(0, 4000),
        correlationId: cleanCorrelationId(correlationId),
      });
      let warning = '';
      try {
        await notifyReviewers({
          offer,
          decision: {
            ok: true,
            action: 'resend_hr_generation_notice',
            to: offer.currentStatus,
            assignee: { userId: '', role: 'HR', name: 'HR' },
          },
          actor,
          history,
        });
      } catch (error) {
        warning = 'The instruction was recorded, but a notification could not be sent.';
      }
      return {
        offer: toPublicOffer(offer, actor),
        warning,
        message: 'HR notification resent for offer generation.',
      };
    }

    if (action === 'request_letter_preparation' || action === 'approve_and_send_for_release') {
      if (actor.role !== 'Admin') {
        throw new OfferWorkflowError('Only Admin can generate the offer.', 403, 'OFFER_FORBIDDEN');
      }
      if (['Letter Preparation Requested', 'Letter Generated'].includes(offer.currentStatus)) {
        return {
          offer: toPublicOffer(offer, actor),
          message: 'This request is already with HR for offer generation.',
        };
      }
    }

    if (action === 'save_review') {
      assertSaveReview(actor, offer);
      let working = offer;
      if (documentVerifications) working = applyDocumentVerifications(offer, documentVerifications, actor);
      const setFields = {};
      if (working !== offer) setFields.documents = working.documents;
      if (actor.role === 'HR' && hrRemarks !== undefined) {
        setFields.hrRemarks = String(hrRemarks || '').trim().slice(0, 4000);
      }
      if (actor.role === 'HR') {
        setFields.responsibleHrUserId = actor.id;
        setFields.responsibleHrName = actor.name || 'HR';
      }
      if (actor.role === 'Admin' && hrRemarks !== undefined) {
        setFields.hrRemarks = String(hrRemarks || '').trim().slice(0, 4000);
      }
      const updated = await deps.conditionalUpdate(
        offer._id,
        offer.currentStatus,
        offer.workflowVersion || 0,
        setFields,
      );
      if (!updated) {
        throw new OfferWorkflowError(
          'This offer request was updated by someone else. Refresh and try again.',
          409,
          'OFFER_CONFLICT',
        );
      }
      await writeHistory({
        offerRequestId: String(updated._id),
        action: 'save_review',
        previousStatus: offer.currentStatus,
        newStatus: offer.currentStatus,
        actorUserId: actor.id,
        actorRole: actor.role,
        comments: String(comments || '').trim().slice(0, 4000),
        correlationId: cleanCorrelationId(correlationId),
      });
      return { offer: toPublicOffer(updated, actor) };
    }

    let working = offer;
    const mayVerifyDocuments = ['verify_and_send_to_admin', 'save_review'].includes(action);
    if (documentVerifications && mayVerifyDocuments) {
      working = applyDocumentVerifications(offer, documentVerifications, actor);
    }
    const decision = resolveTransition({ actor, offer, action, comments, returnTarget });
    if (!decision.ok) {
      throw new OfferWorkflowError(decision.message, decision.statusCode, decision.code);
    }
    if (decision.to === 'Candidate Declined' && !String(decision.comments || '').trim()) {
      throw new OfferWorkflowError(
        'Remark is required when status is Candidate Declined.',
        400,
        'COMMENTS_REQUIRED',
      );
    }
    if (decision.gate) {
      const recalculated = calculateCommercials({
        classification: working.employment?.classification,
        monthlyBillingRate: working.commercial?.monthlyBillingRate,
        monthlyCtcCost: resolveMonthlyCtcCost(working.employment?.monthlyCtc, working.commercial?.monthlyCtcCost),
        employerPfEsiCost: working.commercial?.employerPfEsiCost,
        otherApprovedMonthlyCosts: working.commercial?.otherApprovedMonthlyCosts,
      });
      working = {
        ...working,
        commercial: {
          ...working.commercial,
          ...recalculated,
          commercialRemarks: working.commercial?.commercialRemarks || '',
        },
      };
    }
    if (isOfferGenerationSubmission(decision)) {
      const readiness = assessOfferGenerationReadiness(working);
      if (!readiness.ok) {
        throw new OfferWorkflowError(
          readiness.message || 'Complete all mandatory offer details before submitting.',
          422,
          readiness.code || 'OFFER_GENERATION_VALIDATION_FAILED',
          {
            missingFields: readiness.missingFields,
            missingFieldLabels: readiness.missingFieldLabels,
            missingDocuments: readiness.missingDocuments,
            missingDocumentKeys: readiness.missingDocumentKeys,
            sections: readiness.sections,
            errors: readiness.errors,
          },
        );
      }
    } else if (decision.gate) {
      const stage = decision.gate === 'readyForLetter' ? 'admin' : 'hr';
      const validation = validateOfferForSubmission(working, stage);
      if (!validation.ok) {
        throw new OfferWorkflowError(
          'Complete the required offer details before this action.',
          422,
          'OFFER_INCOMPLETE',
          { errors: validation.errors },
        );
      }
    }

    const setFields = {
      currentStatus: decision.to,
      currentAssigneeUserId: decision.assignee.userId || '',
      currentAssigneeRole: decision.assignee.role || '',
      currentAssigneeName: decision.assignee.name || '',
      isOpen: isOpenOfferStatus(decision.to),
    };
    if (decision.to === 'Letter Preparation Requested') {
      setFields.letterPreparationSource = 'admin';
      setFields.letterPreparationSubmittedByUserId = actor.id || '';
      setFields.letterPreparationSubmittedByRole = actor.role || '';
      setFields.letterPreparationSubmittedByName = actor.name || actor.role || '';
      setFields.adminApprovedAt = new Date();
      setFields.adminApprovedByUserId = actor.id || '';
    }
    if (working !== offer) setFields.documents = working.documents;
    if (decision.gate) setFields.commercial = working.commercial;
    if (actor.role === 'HR' && hrRemarks !== undefined) {
      const typedRemarks = String(hrRemarks || '').trim().slice(0, 4000);
      if (typedRemarks) setFields.hrRemarks = typedRemarks;
      else if (decision.action === 'return_to_tl' && decision.comments) {
        setFields.hrRemarks = String(decision.comments).slice(0, 4000);
      }
    }
    if (decision.to === 'Offer Released') {
      setFields.releasedAt = new Date();
      setFields.releasedByUserId = actor.id;
    }
    if (actor.role === 'HR') {
      setFields.responsibleHrUserId = actor.id;
      setFields.responsibleHrName = actor.name || 'HR';
    }

    const updated = await deps.conditionalUpdate(
      offer._id,
      offer.currentStatus,
      offer.workflowVersion || 0,
      setFields,
    );
    if (!updated) {
      throw new OfferWorkflowError(
        'This offer request was updated by someone else. Refresh and try again.',
        409,
        'OFFER_CONFLICT',
      );
    }

    const historyAction = decision.action === 'admin_return' && decision.returnTarget
      ? `admin_return_to_${decision.returnTarget}`
      : decision.action;
    const history = await writeHistory({
      offerRequestId: String(updated._id),
      action: historyAction,
      previousStatus: decision.from,
      newStatus: decision.to,
      actorUserId: actor.id,
      actorRole: actor.role,
      comments: decision.comments || '',
      correlationId: cleanCorrelationId(correlationId),
    });

    let warning = '';
    try {
      await notifyReviewers({ offer: updated, decision, actor, history });
    } catch (error) {
      warning = 'The workflow update was saved, but a notification could not be sent.';
    }

    if (CANDIDATE_STATUS_BY_OFFER_ACTION[decision.action]) {
      await synchronizeCandidateStatus({
        offer: updated,
        status: decision.to,
        remark: decision.comments,
        actor,
      });
    }

    const message = decision.action === 'request_letter_preparation' || decision.action === 'approve_and_send_for_release'
      ? 'Sent to HR to prepare the offer letter.'
      : decision.action === 'verify_and_send_to_admin'
        ? 'Submitted to Admin for review.'
        : decision.action === 'submit_to_hr'
          ? 'Submitted to HR for verification.'
          : decision.action === 'generate_letter'
            ? 'Offer step recorded as letter generated. No offer letter file is created or stored.'
            : decision.action === 'release_offer'
              ? 'Offer status is now Offer Released. No offer letter email is sent.'
              : decision.action === 'resend_hr_generation_notice'
                ? 'HR notification resent for offer generation.'
                : decision.action === 'admin_return'
                  ? `Returned to ${decision.returnTargetLabel || 'reviewer'}.`
                  : '';
    return { offer: toPublicOffer(updated, actor), warning, message };
  }

  async function repairCompletedOfferCandidate(offerRequestNumber) {
    await gate();
    const offer = await OfferRequest.findOne({ offerRequestNumber: String(offerRequestNumber || '').trim() }).lean();
    if (!offer) throw new OfferWorkflowError('Offer request not found.', 404, 'OFFER_NOT_FOUND');
    const status = COMPLETED_OFFER_CANDIDATE_STATUS[offer.currentStatus];
    if (!status) {
      throw new OfferWorkflowError('This offer is not at a candidate status that is synchronized.', 409, 'INVALID_TRANSITION');
    }
    const result = await reconcileCompletedOffer(offer);
    const context = await deps.findCandidateContext(offer.candidateSubdocumentId);
    return {
      offerRequestNumber: offer.offerRequestNumber,
      offerStatus: offer.currentStatus,
      candidateStatus: getOfferLatestCandidateStatus(context?.candidate),
      appended: result.appended === true,
    };
  }

  return {
    initiateOffer,
    ensureOfferForHrManualStatus,
    listInitiationRecipients,
    listOpenOfferIndicators,
    listOffers,
    getOffer,
    saveDraft,
    assertDocumentUploadAllowed,
    attachDocument,
    removeDocument,
    resolveDownload,
    applyTransition,
    repairCompletedOfferCandidate,
  };
}

const offerWorkflowService = createOfferWorkflowService(defaultDeps);

module.exports = {
  createOfferWorkflowService,
  offerWorkflowService,
  OfferWorkflowError,
  prepareOfferStorage,
  formatOfferRequestNumber,
};
