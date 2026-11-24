const { getLatestStatusEntry } = require('../utils/statusRemarks');
const {
  ELIGIBLE_INITIATION_STATUS,
  OFFER_STATUSES,
  DOCUMENT_TYPES,
  REQUIRED_DOCUMENT_TYPES,
  EXPERIENCED_DOCUMENT_TYPES,
  VERIFICATION_STATUSES,
  EMPLOYMENT_CATEGORIES,
  CLASSIFICATIONS,
  WORK_MODES,
  TL_EDIT_STATUSES,
  isClosedOfferStatus,
  isOpenOfferStatus,
} = require('../utils/offerWorkflow.constants');
const { calculateCommercials, parseMoney, resolveMonthlyCtcCost, OfferFinanceError } = require('./offerFinance.service');
const { canReadOffer, canEditOfferDetails } = require('./offerAccess.service');

class OfferWorkflowError extends Error {
  constructor(message, statusCode = 400, code = 'OFFER_ERROR', details = null) {
    super(message);
    this.name = 'OfferWorkflowError';
    this.isOfferWorkflowError = true;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function isMongoIdString(value) {
  return /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());
}

function normalizeId(value) {
  return String(value || '').trim();
}

function uniqueIds(values) {
  const ids = [];
  (values || []).forEach((value) => {
    const id = normalizeId(value);
    if (id && !ids.includes(id)) ids.push(id);
  });
  return ids;
}

function collectRecruiterIds(candidate, mainDocument) {
  const fromCandidate = uniqueIds(candidate?.recruiterId);
  const fromDocument = uniqueIds(mainDocument?.recruiterId);
  return uniqueIds([...fromCandidate, ...fromDocument]);
}

function primaryRecruiterId(candidate, mainDocument) {
  const fromCandidate = uniqueIds(candidate?.recruiterId);
  if (fromCandidate.length) return fromCandidate[0];
  const all = collectRecruiterIds(candidate, mainDocument);
  return all[0] || '';
}

function getOfferLatestCandidateStatus(candidate) {
  const entry = getLatestStatusEntry(candidate?.Status || []);
  return entry?.Status || '';
}

function assertInitiationStatus(candidate) {
  const latest = getOfferLatestCandidateStatus(candidate);
  if (latest !== ELIGIBLE_INITIATION_STATUS) {
    throw new OfferWorkflowError(
      `Offer can be initiated only when the candidate's latest status is "${ELIGIBLE_INITIATION_STATUS}". Current status: ${latest || 'none'}.`,
      422,
      'CANDIDATE_NOT_ELIGIBLE',
      { latestStatus: latest || '' },
    );
  }
  return latest;
}

function text(value) {
  return String(value || '').trim();
}

function buildCandidateSnapshot(candidate = {}) {
  return {
    firstName: text(candidate.firstName),
    lastName: text(candidate.lastName),
    email: text(candidate.email),
    mobileNumber: text(candidate.mobileNumber),
    dateOfBirth: candidate.dob || null,
    currentAddress: '',
    permanentAddress: '',
    currentLocation: text(candidate.currentLocation),
    currentCompany: text(candidate.currentOrg),
    currentCtc: text(candidate.ctc),
    expectedCtc: text(candidate.ectc),
    totalExperience: text(candidate.totalYoe),
    relevantExperience: text(candidate.relevantYoe),
    technicalSkills: text(candidate.candidateSkills),
    educationalQualification: text(candidate.educationalQualification),
    preferredLocation: text(candidate.prefLocation),
    profileReferences: {
      updatedResume: text(candidate.updatedResume),
      ornnovaProfile: text(candidate.ornnovaProfile),
      candidateImage: text(candidate.candidateImage),
    },
  };
}

function enumOrBlank(value, allowed) {
  const normalized = text(value);
  return allowed.includes(normalized) ? normalized : '';
}

function buildEmploymentSeed(candidate = {}, requirement = null) {
  return {
    employmentCategory: '',
    currentCompany: text(candidate.currentOrg),
    totalExperience: text(candidate.totalYoe),
    relevantExperience: text(candidate.relevantYoe),
    technicalSkills: text(candidate.candidateSkills),
    proposedDesignation: text(candidate.role) || text(requirement?.role),
    classification: '',
    workLocation: text(requirement?.location) || text(candidate.prefLocation) || text(candidate.currentLocation),
    workMode: enumOrBlank(requirement?.workMode, WORK_MODES),
    contractType: text(requirement?.typeOfContract),
    reportingManager: text(requirement?.hiringManager),
    responsibilities: '',
    proposedJoiningDate: null,
    agreedAnnualCtc: null,
    monthlyCtc: null,
  };
}

function buildClientSeed(requirement, clientDoc) {
  return {
    clientId: text(requirement?.clientId),
    clientName: text(clientDoc?.ClientName) || text(requirement?.client),
    clientLocation: text(clientDoc?.Location),
    engagementType: '',
    contractTerms: '',
  };
}

function emptyCommercials() {
  return calculateCommercials({});
}

function resolveTeamLeadSelection({ associatedTeamLeads = [], selectedTeamLead = null } = {}) {
  const associated = associatedTeamLeads.filter((lead) => lead && lead.id);

  if (selectedTeamLead && selectedTeamLead.role === 'HR') {
    if (selectedTeamLead.active !== true) {
      return {
        ok: false,
        statusCode: 422,
        code: 'INVALID_TEAM_LEAD',
        message: 'Selected user must be an active HR user.',
      };
    }
    return { ok: true, teamLead: selectedTeamLead, mode: 'admin_selected_hr' };
  }

  if (associated.length === 1) {
    const only = associated[0];
    if (selectedTeamLead && selectedTeamLead.id !== only.id) {
      return {
        ok: false,
        statusCode: 422,
        code: 'TEAM_LEAD_NOT_ASSOCIATED',
        message: 'The selected Team Lead is not the Team Lead assigned to this recruiter.',
      };
    }
    return { ok: true, teamLead: only, mode: 'single_assigned' };
  }

  if (!selectedTeamLead) {
    const reason = associated.length === 0 ? 'none' : 'multiple';
    return {
      ok: false,
      statusCode: 422,
      code: 'TEAM_LEAD_SELECTION_REQUIRED',
      message: reason === 'none'
        ? 'No active Team Lead is assigned to this recruiter. Select an active Team Lead.'
        : 'More than one active Team Lead is assigned to this recruiter. Select the responsible Team Lead.',
      details: {
        reason,
        teamLeads: associated.map((lead) => ({ id: lead.id, name: lead.name || '' })),
      },
    };
  }

  if (selectedTeamLead.role !== 'TeamLead' || selectedTeamLead.active !== true) {
    return {
      ok: false,
      statusCode: 422,
      code: 'INVALID_TEAM_LEAD',
      message: 'Selected user must be an active Team Lead.',
    };
  }

  if (associated.length > 1) {
    const match = associated.find((lead) => lead.id === selectedTeamLead.id);
    if (!match) {
      return {
        ok: false,
        statusCode: 422,
        code: 'TEAM_LEAD_NOT_ASSOCIATED',
        message: 'Selected Team Lead is not assigned to this recruiter.',
      };
    }
    return { ok: true, teamLead: match, mode: 'selected_associated' };
  }

  return { ok: true, teamLead: selectedTeamLead, mode: 'admin_override_unassigned' };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const CANDIDATE_FIELDS = [
  'firstName', 'lastName', 'email', 'mobileNumber', 'dateOfBirth',
  'currentAddress', 'permanentAddress', 'currentLocation', 'currentCompany',
  'currentCtc', 'expectedCtc', 'totalExperience', 'relevantExperience',
  'technicalSkills', 'educationalQualification', 'preferredLocation',
];

const EMPLOYMENT_FIELDS = [
  'employmentCategory', 'currentCompany', 'totalExperience', 'relevantExperience',
  'technicalSkills', 'proposedDesignation',
  'classification', 'workLocation', 'workMode', 'contractType', 'reportingManager',
  'responsibilities', 'proposedJoiningDate', 'agreedAnnualCtc', 'monthlyCtc',
];

const CLIENT_FIELDS = [
  'clientName', 'clientLocation', 'engagementType', 'contractTerms',
];

function assertEnum(value, allowed, label, { allowBlank = true } = {}) {
  const normalized = text(value);
  if (!normalized && allowBlank) return '';
  if (!allowed.includes(normalized)) {
    throw new OfferWorkflowError(`${label} must be one of: ${allowed.join(', ')}`, 400, 'INVALID_FIELD');
  }
  return normalized;
}

function parseDateOrNull(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new OfferWorkflowError(`${label} is not a valid date`, 400, 'INVALID_FIELD');
  }
  return parsed.toISOString();
}

function normalizeContractTerms(value) {
  const normalized = text(value);
  if (!normalized) return '';
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    const months = Number(normalized);
    if (!Number.isInteger(months) || months < 1) {
      throw new OfferWorkflowError('Contract Terms must be a positive number of months', 400, 'INVALID_FIELD');
    }
    return String(months);
  }
  return normalized;
}

function applyDraftPatch(offer, payload = {}) {
  if (!offer) {
    throw new OfferWorkflowError('Offer request not found', 404, 'OFFER_NOT_FOUND');
  }

  const next = clone(offer);
  const candidatePatch = payload.candidate || {};
  const employmentPatch = payload.employment || {};
  const clientPatch = payload.client || {};
  const commercialPatch = payload.commercial || {};

  CANDIDATE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(candidatePatch, field)) {
      if (field === 'dateOfBirth') {
        next.candidateSnapshot[field] = parseDateOrNull(candidatePatch[field], 'Date of birth');
      } else {
        next.candidateSnapshot[field] = text(candidatePatch[field]);
      }
    }
  });

  delete next.education;

  EMPLOYMENT_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(employmentPatch, field)) return;
    if (field === 'employmentCategory') {
      next.employment[field] = assertEnum(employmentPatch[field], EMPLOYMENT_CATEGORIES, 'Employment category');
    } else if (field === 'classification') {
      next.employment[field] = assertEnum(employmentPatch[field], CLASSIFICATIONS, 'Classification');
    } else if (field === 'workMode') {
      next.employment[field] = assertEnum(employmentPatch[field], WORK_MODES, 'Work mode');
    } else if (field === 'proposedJoiningDate') {
      next.employment[field] = parseDateOrNull(employmentPatch[field], 'Proposed joining date');
    } else if (field === 'contractType') {
      const incoming = text(employmentPatch[field]);
      if (incoming) next.employment[field] = incoming;
    } else if (field === 'agreedAnnualCtc' || field === 'monthlyCtc') {
      try {
        next.employment[field] = parseMoney(
          employmentPatch[field],
          field === 'agreedAnnualCtc' ? 'Client Offering Annual CTC' : 'Candidate Agreed Annual CTC',
          { positive: field === 'monthlyCtc' },
        );
      } catch (error) {
        if (error instanceof OfferFinanceError) {
          throw new OfferWorkflowError(error.message, 400, error.code);
        }
        throw error;
      }
    } else {
      next.employment[field] = text(employmentPatch[field]);
    }
  });
  if (next.employment) {
    delete next.employment.employmentType;
    delete next.employment.offerType;
  }

  CLIENT_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(clientPatch, field)) return;
    if (field === 'contractTerms') {
      next.client[field] = normalizeContractTerms(clientPatch[field]);
    } else {
      next.client[field] = text(clientPatch[field]);
    }
  });
  if (next.client) delete next.client.projectDetails;

  if (Object.prototype.hasOwnProperty.call(payload, 'otherExpenses')) {
    next.otherExpenses = sanitizeOtherExpenses(payload.otherExpenses);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'hasOtherExpenses')) {
    next.hasOtherExpenses = payload.hasOtherExpenses === true;
    if (!next.hasOtherExpenses) next.otherExpenses = [];
  } else if (Object.prototype.hasOwnProperty.call(payload, 'otherExpenses')) {
    next.hasOtherExpenses = next.otherExpenses.length > 0;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'commercialNotes')) {
    next.commercialNotes = boundedParagraph(payload.commercialNotes, 'Offer justification');
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'internalRemarks')) {
    next.internalRemarks = boundedParagraph(payload.internalRemarks, 'Approval remarks');
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'additionalRemarks')) {
    const remarks = text(payload.additionalRemarks);
    if (remarks.length > 4000) {
      throw new OfferWorkflowError('Remarks must be 4000 characters or fewer', 400, 'INVALID_FIELD');
    }
    next.additionalRemarks = remarks;
  }

  const commercialInput = {
    classification: next.employment.classification,
    monthlyBillingRate: next.commercial.monthlyBillingRate,
    monthlyCtcCost: resolveMonthlyCtcCost(next.employment.monthlyCtc, next.commercial.monthlyCtcCost),
    // Preserve historical values if present; these are no longer editable in the workflow UI.
    employerPfEsiCost: next.commercial.employerPfEsiCost,
    otherApprovedMonthlyCosts: next.commercial.otherApprovedMonthlyCosts,
  };

  ['monthlyBillingRate', 'monthlyCtcCost'].forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(commercialPatch, field)) return;
    const labels = {
      monthlyBillingRate: 'Monthly billing rate',
      monthlyCtcCost: 'Monthly CTC cost',
    };
    try {
      if (field === 'monthlyCtcCost' && next.employment.monthlyCtc != null && next.employment.monthlyCtc !== '') {
        return;
      }
      commercialInput[field] = parseMoney(commercialPatch[field], labels[field]);
    } catch (error) {
      if (error instanceof OfferFinanceError) {
        throw new OfferWorkflowError(error.message, 400, error.code);
      }
      throw error;
    }
  });

  if (Object.prototype.hasOwnProperty.call(commercialPatch, 'commercialRemarks')) {
    next.commercial.commercialRemarks = text(commercialPatch.commercialRemarks).slice(0, 4000);
  }

  const calculated = calculateCommercials(commercialInput);
  next.commercial = {
    ...next.commercial,
    ...calculated,
    // Keep any historical PF/other values; do not accept new workflow edits for them.
    employerPfEsiCost: next.commercial.employerPfEsiCost ?? null,
    otherApprovedMonthlyCosts: next.commercial.otherApprovedMonthlyCosts ?? null,
    commercialRemarks: next.commercial.commercialRemarks || '',
  };

  return next;
}

function boundedParagraph(value, label) {
  const notes = text(value);
  if (notes.length > 4000) {
    throw new OfferWorkflowError(`${label} must be 4000 characters or fewer`, 400, 'INVALID_FIELD');
  }
  return notes;
}

function sanitizeOtherExpenses(rows) {
  if (!Array.isArray(rows)) {
    throw new OfferWorkflowError('Other expenses must be a list.', 400, 'INVALID_FIELD');
  }
  if (rows.length > 50) {
    throw new OfferWorkflowError('Other expenses are limited to 50 rows.', 400, 'INVALID_FIELD');
  }
  const cleaned = [];
  rows.forEach((row) => {
    const description = text(row?.description).slice(0, 200);
    const rawAmount = row?.amount;
    const amountBlank = rawAmount === '' || rawAmount == null;
    if (!description && amountBlank) return;
    if (!description || amountBlank) {
      throw new OfferWorkflowError(
        'Each expense needs both a description and an amount.',
        400,
        'INVALID_FIELD',
      );
    }
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new OfferWorkflowError('Expense amounts must be zero or greater.', 400, 'INVALID_FIELD');
    }
    const sign = amount < 0 ? -1 : 1;
    const cents = Math.round((Math.abs(amount) * 100) + 1e-8);
    cleaned.push({ description, amount: (sign * cents) / 100 });
  });
  return cleaned;
}

function requiredText(errors, value, label) {
  if (!text(value)) errors.push(`${label} is required`);
}

function requirePositiveAmount(errors, value, label) {
  if (value === null || value === undefined || value === '') {
    errors.push(`${label} is required`);
    return;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    errors.push(`${label} must be a positive amount`);
  }
}

function parseExperienceYears(value) {
  const raw = text(value);
  if (!raw || /^(not mentioned|n\/a|na|nil|none|-+|—|–)$/i.test(raw)) return null;
  const yearsInParens = raw.match(/\(\s*(\d+(?:\.\d+)?)\s*years?\s*\)/i);
  if (yearsInParens) return Number(yearsInParens[1]);
  if (/months?/i.test(raw) && !/years?/i.test(raw)) {
    const months = raw.match(/(\d+(?:\.\d+)?)/);
    return months ? Number(months[1]) / 12 : null;
  }
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const years = Number(match[1]);
  return Number.isFinite(years) ? years : null;
}

function pushMissing(section, missingFields, key, label) {
  section.missing.push(label);
  section.complete = false;
  missingFields.push({ key, label, section: section.id });
}

function isUploadedDocument(document) {
  if (!document) return false;
  return Boolean(text(document.originalFilename) && text(document.storageKey));
}

function requiredDocumentTypesForOffer(offer) {
  const employment = offer?.employment || {};
  const types = [...REQUIRED_DOCUMENT_TYPES];
  if (employment.employmentCategory === 'Experienced') {
    types.push(...EXPERIENCED_DOCUMENT_TYPES);
  }
  return types;
}

/** Shared readiness check for Admin/HR offer-generation submission. */
function assessOfferGenerationReadiness(offer) {
  const candidate = offer?.candidateSnapshot || {};
  const employment = offer?.employment || {};
  const client = offer?.client || {};
  const commercial = offer?.commercial || {};
  const sections = {
    candidate: { id: 'candidate', label: 'Candidate Details', complete: true, missing: [] },
    employment: { id: 'employment', label: 'Employment & Compensation', complete: true, missing: [] },
    client: { id: 'client', label: 'Client & Billing', complete: true, missing: [] },
    documents: { id: 'documents', label: 'Documents', complete: true, optional: true, missing: [] },
  };
  const missingFields = [];
  const missingDocuments = [];
  const errors = [];

  if (!text(candidate.firstName)) pushMissing(sections.candidate, missingFields, 'firstName', 'First name');
  if (!text(candidate.lastName)) pushMissing(sections.candidate, missingFields, 'lastName', 'Last name');
  if (!text(candidate.email)) pushMissing(sections.candidate, missingFields, 'email', 'Email');
  if (!text(candidate.mobileNumber)) pushMissing(sections.candidate, missingFields, 'mobileNumber', 'Mobile number');
  if (!text(candidate.currentAddress)) pushMissing(sections.candidate, missingFields, 'currentAddress', 'Current address');
  if (!text(candidate.permanentAddress)) pushMissing(sections.candidate, missingFields, 'permanentAddress', 'Permanent address');

  if (!EMPLOYMENT_CATEGORIES.includes(employment.employmentCategory)) {
    pushMissing(sections.employment, missingFields, 'employmentCategory', 'Fresher or experienced');
  }
  if (employment.employmentCategory === 'Experienced'
    && !text(employment.currentCompany)
    && !text(candidate.currentCompany)) {
    pushMissing(sections.employment, missingFields, 'currentCompany', 'Current company');
  }
  if (employment.employmentCategory === 'Experienced') {
    const totalYears = parseExperienceYears(employment.totalExperience);
    const relevantYears = parseExperienceYears(employment.relevantExperience);
    if (totalYears == null || totalYears < 0) {
      pushMissing(sections.employment, missingFields, 'totalExperience', 'Total experience');
    }
    if (relevantYears == null || relevantYears < 0) {
      pushMissing(sections.employment, missingFields, 'relevantExperience', 'Relevant experience');
    } else if (totalYears != null && totalYears >= 0 && relevantYears > totalYears) {
      sections.employment.complete = false;
      sections.employment.missing.push('Relevant experience cannot exceed total experience');
      errors.push('Relevant experience cannot exceed total experience.');
    }
  }
  if (!text(employment.proposedDesignation)) {
    pushMissing(sections.employment, missingFields, 'proposedDesignation', 'Proposed designation');
  }
  if (!CLASSIFICATIONS.includes(employment.classification)) {
    pushMissing(sections.employment, missingFields, 'classification', 'Classification');
  }
  if (!text(employment.workLocation)) {
    pushMissing(sections.employment, missingFields, 'workLocation', 'Work location');
  }
  if (!WORK_MODES.includes(employment.workMode)) {
    pushMissing(sections.employment, missingFields, 'workMode', 'Work mode');
  }
  if (!employment.proposedJoiningDate) {
    pushMissing(sections.employment, missingFields, 'proposedJoiningDate', 'Proposed joining date');
  }
  const annualCtc = employment.monthlyCtc;
  if (annualCtc === null || annualCtc === undefined || annualCtc === '' || !(Number(annualCtc) > 0)) {
    pushMissing(sections.employment, missingFields, 'monthlyCtc', 'Candidate Agreed Annual CTC');
  }
  const resolvedMonthlyCtcCost = resolveMonthlyCtcCost(employment.monthlyCtc, commercial.monthlyCtcCost);
  if (resolvedMonthlyCtcCost === null || resolvedMonthlyCtcCost === undefined) {
    if (!sections.employment.missing.includes('Candidate Agreed Annual CTC')) {
      pushMissing(sections.employment, missingFields, 'monthlyCtc', 'Candidate Agreed Annual CTC');
    }
  }

  if (employment.classification === 'Billable' && !text(client.clientName)) {
    pushMissing(sections.client, missingFields, 'clientName', 'Client name');
  }

  missingFields.forEach((field) => {
    errors.push(`${field.label} is required`);
  });

  const sectionList = Object.values(sections).map((section) => ({
    id: section.id,
    label: section.label,
    complete: section.complete,
    optional: section.optional === true,
    missing: section.missing,
  }));

  return {
    ok: errors.length === 0,
    message: 'Complete all mandatory offer details before submitting.',
    code: 'OFFER_GENERATION_VALIDATION_FAILED',
    sections: sectionList,
    missingFields: missingFields.map((field) => field.key),
    missingFieldLabels: missingFields.map((field) => field.label),
    missingDocuments: missingDocuments.map((document) => document.label),
    missingDocumentKeys: missingDocuments.map((document) => document.key),
    errors,
  };
}

function validateOfferForSubmission(offer, stage) {
  const readiness = assessOfferGenerationReadiness(offer);
  const errors = readiness.errors.filter((error) => !String(error).startsWith('Upload the required document:'));

  if (stage === 'admin') {
    const documents = Array.isArray(offer?.documents) ? offer.documents : [];
    requiredDocumentTypesForOffer(offer).forEach((type) => {
      const matches = documents.filter((document) => document.documentType === type && isUploadedDocument(document));
      if (matches.length && !matches.some((document) => document.verificationStatus === 'Verified')) {
        errors.push(`Document must be verified before Admin approval: ${type}`);
      }
    });
  }

  return { ok: errors.length === 0, errors, readiness };
}

function isOfferGenerationSubmission(decision) {
  if (!decision?.ok) return false;
  if (decision.action === 'request_letter_preparation') return true;
  if (decision.action === 'approve_and_send_for_release') return true;
  if (decision.action === 'generate_letter') return true;
  if (decision.action === 'approve' && decision.to === 'Letter Preparation Requested') return true;
  return decision.gate === 'readyForLetter';
}

function normalizeComments(value, required, { returnRemarks = false } = {}) {
  const comments = text(value);
  if (required && !comments) {
    throw new OfferWorkflowError(
      returnRemarks
        ? 'Return remarks are required. Please enter a reason before proceeding.'
        : 'Comments are required for this action.',
      400,
      'COMMENTS_REQUIRED',
    );
  }
  if (comments.length > 4000) {
    throw new OfferWorkflowError('Comments must be 4000 characters or fewer', 400, 'INVALID_FIELD');
  }
  return comments;
}

/** Open pre-release stages where Admin may return to TL or HR. */
const ADMIN_RETURN_FROM_STATUSES = [
  'Initiated',
  'TL Review',
  'Returned to TL',
  'Returned to TL by MD',
  'HR Review',
  'Returned to HR',
  'MD Review',
  'MD Approved',
  'Admin Review',
  'Returned by Admin',
  'Letter Preparation Requested',
  'Letter Generated',
];

const RETURN_TARGET_LABELS = {
  tl: 'Team Lead',
  hr: 'HR',
};

function assigneeRole(offer, role, name) {
  return { userId: '', role, name: name || role };
}

function responsibleAssignee(offer) {
  return {
    userId: offer.responsibleTeamLeadUserId,
    role: 'TeamLead',
    name: offer.responsibleTeamLeadName || 'Team Lead',
  };
}

const TRANSITIONS = [
  { action: 'submit_to_hr', from: ['Initiated', 'TL Review', 'Returned to TL', 'Returned to TL by MD'], to: 'HR Review', roles: ['TeamLead'], gate: 'readyForHr', assignee: 'hr' },
  { action: 'submit_to_hr', from: ['Returned by Admin'], to: 'HR Review', roles: ['TeamLead'], gate: 'readyForHr', assignee: 'hr', requireAssigneeRole: 'TeamLead' },
  { action: 'verify_and_send_to_admin', from: ['Initiated', 'TL Review', 'Returned to TL', 'Returned to TL by MD', 'HR Review', 'Returned to HR'], to: 'Admin Review', roles: ['HR'], gate: 'readyForHr', assignee: 'admin' },
  { action: 'verify_and_send_to_admin', from: ['Returned by Admin'], to: 'Admin Review', roles: ['HR'], gate: 'readyForHr', assignee: 'admin', requireAssigneeRole: 'TeamLead' },
  { action: 'verify_and_send_to_admin', from: ['Returned by Admin'], to: 'Admin Review', roles: ['HR'], gate: 'readyForHr', assignee: 'admin', requireAssigneeRole: 'HR' },
  { action: 'approve_and_send_for_release', from: ['Initiated', 'TL Review', 'Returned to TL', 'Returned to TL by MD', 'HR Review', 'Returned to HR', 'Returned by Admin', 'Admin Review', 'MD Review', 'MD Approved'], to: 'Letter Preparation Requested', roles: ['Admin'], gate: 'readyForLetter', assignee: 'hr' },
  { action: 'request_letter_preparation', from: ['Admin Review', 'MD Review', 'MD Approved'], to: 'Letter Preparation Requested', roles: ['Admin'], gate: 'readyForLetter', assignee: 'hr' },
  { action: 'generate_letter', from: ['Letter Preparation Requested'], to: 'Letter Generated', roles: ['HR'], gate: 'readyForLetter', assignee: 'hr' },
  { action: 'release_offer', from: ['Letter Preparation Requested', 'Letter Generated'], to: 'Offer Released', roles: ['HR', 'Admin'], assignee: 'actor' },
  { action: 'mark_accepted', from: ['Offer Released'], to: 'Offer Accepted', roles: ['Admin', 'HR', 'TeamLead'], assignee: 'actor', teamLeadMustBeResponsible: true },
  { action: 'mark_declined', from: ['Offer Released', 'Offer Accepted'], to: 'Candidate Declined', roles: ['Admin', 'HR', 'TeamLead'], assignee: 'actor', teamLeadMustBeResponsible: true },
  { action: 'confirm_onboard', from: ['Offer Accepted'], to: 'Onboard Confirmation', roles: ['Admin', 'HR', 'TeamLead'], assignee: 'actor', teamLeadMustBeResponsible: true },
  { action: 'mark_joined', from: ['Onboard Confirmation'], to: 'Joined', roles: ['Admin', 'HR', 'TeamLead'], assignee: 'actor', teamLeadMustBeResponsible: true },
];

function responsibleHrAssignee(offer) {
  const userId = String(offer?.responsibleHrUserId || '').trim();
  if (!userId) return assigneeRole(offer, 'HR', 'HR');
  return {
    userId,
    role: 'HR',
    name: offer.responsibleHrName || 'HR',
  };
}

function resolveAssignee(kind, offer, actor, returnTarget) {
  if (kind === 'hr') return responsibleHrAssignee(offer);
  if (kind === 'admin') return assigneeRole(offer, 'Admin', 'Admin');
  if (kind === 'tl') return responsibleAssignee(offer);
  if (kind === 'actor') return { userId: actor.id, role: actor.role, name: actor.name || actor.role };
  if (kind === 'admin_return') {
    if (returnTarget === 'hr') return responsibleHrAssignee(offer);
  }
  return { userId: offer.currentAssigneeUserId || '', role: offer.currentAssigneeRole || '', name: offer.currentAssigneeName || '' };
}

function isReturnAction(action) {
  const name = String(action || '');
  return name === 'admin_return' || name.startsWith('return_') || name.startsWith('admin_return_');
}

function resolveTransition({ actor, offer, action, comments, returnTarget } = {}) {
  if (!actor || !OFFER_STATUSES.includes(offer?.currentStatus)) {
    return { ok: false, statusCode: 400, code: 'INVALID_TRANSITION', message: 'This offer request cannot be transitioned.' };
  }
  if (!canReadOffer(actor, offer) && !(actor.role === 'TeamLead' && offer.responsibleTeamLeadUserId === actor.id)) {
    return { ok: false, statusCode: 403, code: 'OFFER_FORBIDDEN', message: 'You do not have permission to update this offer request.' };
  }

  if (action === 'cancel') {
    if (actor.role !== 'Admin') {
      return { ok: false, statusCode: 403, code: 'OFFER_FORBIDDEN', message: 'Only Admin can cancel an offer request.' };
    }
    if (!isOpenOfferStatus(offer.currentStatus)) {
      return { ok: false, statusCode: 409, code: 'INVALID_TRANSITION', message: 'This offer request is already closed.' };
    }
    let normalized;
    try {
      normalized = normalizeComments(comments, true);
    } catch (error) {
      return { ok: false, statusCode: error.statusCode, code: error.code, message: error.message };
    }
    return {
      ok: true,
      action,
      from: offer.currentStatus,
      to: 'Cancelled',
      comments: normalized,
      assignee: resolveAssignee('actor', offer, actor),
      gate: null,
    };
  }

  if (action === 'generate_letter' && actor.role !== 'HR') {
    return {
      ok: false,
      statusCode: 403,
      code: 'OFFER_FORBIDDEN',
      message: 'Only HR can generate the offer letter.',
    };
  }

  if (action === 'release_offer' && !['HR', 'Admin'].includes(actor.role)) {
    return {
      ok: false,
      statusCode: 403,
      code: 'OFFER_FORBIDDEN',
      message: 'Only HR or Admin can release the offer.',
    };
  }

  if (action === 'approve_and_send_for_release' || action === 'request_letter_preparation') {
    if (actor.role !== 'Admin') {
      return {
        ok: false,
        statusCode: 403,
        code: 'OFFER_FORBIDDEN',
        message: 'Only Admin can generate the offer.',
      };
    }
  }

  if (isReturnAction(action)) {
    if (actor.role === 'HR') {
      return {
        ok: false,
        statusCode: 403,
        code: 'OFFER_FORBIDDEN',
        message: 'HR cannot return an offer request.',
      };
    }
    if (actor.role === 'TeamLead') {
      return {
        ok: false,
        statusCode: 403,
        code: 'OFFER_FORBIDDEN',
        message: 'Team Lead cannot return an offer request.',
      };
    }
    if (actor.role !== 'Admin' || action !== 'admin_return' || returnTarget !== 'hr') {
      return {
        ok: false,
        statusCode: 403,
        code: 'OFFER_FORBIDDEN',
        message: 'Offer requests can only be returned to HR.',
      };
    }
  }

  if (action === 'admin_return') {
    if (actor.role !== 'Admin') {
      return { ok: false, statusCode: 403, code: 'OFFER_FORBIDDEN', message: 'Only Admin can return an offer request.' };
    }
    if (returnTarget !== 'hr') {
      return {
        ok: false,
        statusCode: 403,
        code: 'OFFER_FORBIDDEN',
        message: 'Offer requests can only be returned to HR.',
      };
    }
    if (!ADMIN_RETURN_FROM_STATUSES.includes(offer.currentStatus)) {
      return {
        ok: false,
        statusCode: 409,
        code: 'INVALID_TRANSITION',
        message: isClosedOfferStatus(offer.currentStatus)
          || ['Offer Released', 'Offer Accepted', 'Onboard Confirmation'].includes(offer.currentStatus)
          ? 'Admin cannot return an offer that is already released, closed, or past offer release.'
          : 'Admin cannot return this offer from its current workflow stage.',
      };
    }
    let normalized;
    try {
      normalized = normalizeComments(comments, true, { returnRemarks: true });
    } catch (error) {
      return { ok: false, statusCode: error.statusCode, code: error.code, message: error.message };
    }
    return {
      ok: true,
      action,
      from: offer.currentStatus,
      to: 'Returned by Admin',
      comments: normalized,
      assignee: resolveAssignee('admin_return', offer, actor, returnTarget),
      returnTarget,
      returnTargetLabel: RETURN_TARGET_LABELS[returnTarget],
      gate: null,
    };
  }

  const match = TRANSITIONS.find((entry) => (
    entry.action === action
    && entry.from.includes(offer.currentStatus)
    && entry.roles.includes(actor.role)
    && (!entry.requireAssigneeRole || offer.currentAssigneeRole === entry.requireAssigneeRole)
  ));

  if (!match) {
    return {
      ok: false,
      statusCode: 409,
      code: 'INVALID_TRANSITION',
      message: 'This action is not allowed for the current stage or your role.',
    };
  }

  if (match.teamLeadMustBeResponsible && actor.role === 'TeamLead' && offer.responsibleTeamLeadUserId !== actor.id) {
    return { ok: false, statusCode: 403, code: 'OFFER_FORBIDDEN', message: 'You can update only offer requests assigned to you.' };
  }

  if (!canReadOffer(actor, offer)) {
    return { ok: false, statusCode: 403, code: 'OFFER_FORBIDDEN', message: 'You do not have permission to update this offer request.' };
  }

  if (match.blocked) {
    return {
      ok: false,
      statusCode: 403,
      code: 'LETTER_GENERATION_NOT_AVAILABLE',
      message: 'Letter generation is not available in this phase.',
    };
  }

  let normalized = '';
  try {
    normalized = normalizeComments(comments, Boolean(match.requiresComment), {
      returnRemarks: Boolean(match.requiresComment && String(match.action || '').startsWith('return_')),
    });
  } catch (error) {
    return { ok: false, statusCode: error.statusCode, code: error.code, message: error.message };
  }

  return {
    ok: true,
    action,
    from: offer.currentStatus,
    to: match.to,
    comments: normalized,
    assignee: resolveAssignee(match.assignee, offer, actor),
    gate: match.gate || null,
  };
}

function applyDocumentVerifications(offer, verifications, actor) {
  if (!verifications) return offer;
  if (actor.role !== 'HR') {
    throw new OfferWorkflowError('Only HR can verify documents.', 403, 'OFFER_FORBIDDEN');
  }
  const hrCanVerify = ['HR Review', 'Returned to HR'].includes(offer.currentStatus)
    || (offer.currentStatus === 'Returned by Admin' && offer.currentAssigneeRole === 'HR');
  if (!hrCanVerify) {
    throw new OfferWorkflowError('Documents can be verified only during HR verification.', 409, 'INVALID_TRANSITION');
  }
  if (!Array.isArray(verifications)) {
    throw new OfferWorkflowError('Document verifications must be a list.', 400, 'INVALID_FIELD');
  }

  const next = clone(offer);
  verifications.forEach((entry) => {
    const documentId = normalizeId(entry?.documentId);
    const document = (next.documents || []).find((item) => normalizeId(item._id || item.id) === documentId);
    if (!document) {
      throw new OfferWorkflowError('One of the documents could not be found on this offer request.', 400, 'DOCUMENT_NOT_FOUND');
    }
    if (!VERIFICATION_STATUSES.includes(entry.verificationStatus)) {
      throw new OfferWorkflowError('Verification status must be Pending, Verified, or Rejected.', 400, 'INVALID_FIELD');
    }
    const verificationComments = text(entry.verificationComments);
    if (entry.verificationStatus === 'Rejected' && !verificationComments) {
      throw new OfferWorkflowError('Comments are required when a document is rejected.', 400, 'COMMENTS_REQUIRED');
    }
    document.verificationStatus = entry.verificationStatus;
    document.verificationComments = verificationComments;
  });
  return next;
}

function assertDocumentType(documentType) {
  if (!DOCUMENT_TYPES.includes(documentType)) {
    throw new OfferWorkflowError(
      `Document type must be one of: ${DOCUMENT_TYPES.join(', ')}`,
      400,
      'INVALID_DOCUMENT_TYPE',
    );
  }
}

function canUploadDocuments(actor, offer) {
  return canEditOfferDetails(actor, offer);
}

function notificationAudience(decision) {
  if (!decision?.ok) return null;
  if (decision.assignee?.userId) return { type: 'user', userId: decision.assignee.userId };
  if (decision.assignee?.role) return { type: 'role', role: decision.assignee.role };
  return null;
}

module.exports = {
  OfferWorkflowError,
  isMongoIdString,
  normalizeId,
  collectRecruiterIds,
  primaryRecruiterId,
  getOfferLatestCandidateStatus,
  assertInitiationStatus,
  buildCandidateSnapshot,
  buildEmploymentSeed,
  buildClientSeed,
  emptyCommercials,
  resolveTeamLeadSelection,
  applyDraftPatch,
  assessOfferGenerationReadiness,
  validateOfferForSubmission,
  isOfferGenerationSubmission,
  resolveTransition,
  applyDocumentVerifications,
  assertDocumentType,
  canUploadDocuments,
  notificationAudience,
  isClosedOfferStatus,
  clone,
};
