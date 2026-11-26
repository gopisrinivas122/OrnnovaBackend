const mongoose = require('mongoose');
const {
  OFFER_STATUSES,
  DOCUMENT_TYPES,
  VERIFICATION_STATUSES,
  EMPLOYMENT_CATEGORIES,
  CLASSIFICATIONS,
  WORK_MODES,
  FINANCE_CALCULATION_VERSION,
} = require('../utils/offerWorkflow.constants');

const documentSchema = new mongoose.Schema({
  documentType: { type: String, enum: DOCUMENT_TYPES, required: true },
  originalFilename: { type: String, required: true },
  storageKey: { type: String, required: true },
  mimeType: { type: String, default: '' },
  size: { type: Number, default: 0 },
  uploadedByUserId: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  verificationStatus: { type: String, enum: VERIFICATION_STATUSES, default: 'Pending' },
  verificationComments: { type: String, default: '' },
  remarks: { type: String, default: '' },
});

const offerRequestSchema = new mongoose.Schema({
  offerRequestNumber: { type: String, required: true },
  candidateDocumentId: { type: String, required: true },
  candidateSubdocumentId: { type: String, required: true },
  sourceReqId: { type: String, default: '' },
  requirementMongoId: { type: String, default: '' },
  requirementBusinessId: { type: String, default: '' },
  recruiterUserId: { type: String, required: true },
  recruiterUserIds: { type: [String], default: [] },
  initiatedByUserId: { type: String, required: true },
  initiatedByRole: { type: String, default: 'Admin' },
  initiationRoute: { type: String, enum: ['tl', 'direct_hr', 'TL_REVIEW', 'DIRECT_TO_HR', ''], default: '' },
  tlStageSkipped: { type: Boolean, default: false },
  responsibleTeamLeadUserId: { type: String, default: '' },
  responsibleTeamLeadName: { type: String, default: '' },
  responsibleHrUserId: { type: String, default: '' },
  responsibleHrName: { type: String, default: '' },
  teamLeadSelectionMode: {
    type: String,
    enum: ['single_assigned', 'selected_associated', 'admin_override_unassigned', 'admin_selected_hr', 'direct_hr_skip', 'selected_hr'],
    required: true,
  },
  adminApprovedAt: { type: Date, default: null },
  adminApprovedByUserId: { type: String, default: '' },
  currentAssigneeUserId: { type: String, default: '' },
  currentAssigneeRole: { type: String, default: '' },
  currentAssigneeName: { type: String, default: '' },
  currentStatus: { type: String, enum: OFFER_STATUSES, required: true },
  letterPreparationSource: {
    type: String,
    enum: ['admin', 'md', ''],
    default: '',
  },
  letterPreparationSubmittedByUserId: { type: String, default: '' },
  letterPreparationSubmittedByRole: { type: String, default: '' },
  letterPreparationSubmittedByName: { type: String, default: '' },
  isOpen: { type: Boolean, default: true },
  workflowVersion: { type: Number, default: 0 },
  sourceSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  candidateSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  employment: {
    employmentCategory: { type: String, enum: [...EMPLOYMENT_CATEGORIES, ''], default: '' },
    currentCompany: { type: String, default: '' },
    totalExperience: { type: String, default: '' },
    relevantExperience: { type: String, default: '' },
    technicalSkills: { type: String, default: '' },
    proposedDesignation: { type: String, default: '' },
    classification: { type: String, enum: [...CLASSIFICATIONS, ''], default: '' },
    workLocation: { type: String, default: '' },
    workMode: { type: String, enum: [...WORK_MODES, ''], default: '' },
    contractType: { type: String, default: '' },
    reportingManager: { type: String, default: '' },
    responsibilities: { type: String, default: '' },
    proposedJoiningDate: { type: Date, default: null },
    agreedAnnualCtc: { type: Number, default: null },
    monthlyCtc: { type: Number, default: null },
  },
  client: {
    clientId: { type: String, default: '' },
    clientName: { type: String, default: '' },
    clientLocation: { type: String, default: '' },
    engagementType: { type: String, default: '' },
    contractTerms: { type: String, default: '' },
  },
  commercial: {
    monthlyBillingRate: { type: Number, default: null },
    monthlyCtcCost: { type: Number, default: null },
    employerPfEsiCost: { type: Number, default: null },
    otherApprovedMonthlyCosts: { type: Number, default: null },
    monthlyTotalCost: { type: Number, default: 0 },
    monthlyMargin: { type: Number, default: null },
    marginPercentage: { type: Number, default: null },
    marginStatus: { type: String, enum: ['calculated', 'not_applicable'], default: 'not_applicable' },
    calculationVersion: { type: String, default: FINANCE_CALCULATION_VERSION },
    commercialRemarks: { type: String, default: '' },
  },
  documents: { type: [documentSchema], default: [] },
  hasOtherExpenses: { type: Boolean, default: false },
  otherExpenses: {
    type: [{
      description: { type: String, default: '' },
      amount: { type: Number, default: 0 },
    }],
    default: [],
  },
  commercialNotes: { type: String, default: '' },
  internalRemarks: { type: String, default: '' },
  additionalRemarks: { type: String, default: '' },
  hrRemarks: { type: String, default: '' },
  mdRemarks: { type: String, default: '' },
  letter: {
    version: { type: Number, default: null },
    storageKey: { type: String, default: '' },
    generatedAt: { type: Date, default: null },
    generatedByUserId: { type: String, default: '' },
    templateId: { type: String, default: '' },
  },
  releasedAt: { type: Date, default: null },
  releasedByUserId: { type: String, default: '' },
}, {
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
});

offerRequestSchema.index({ offerRequestNumber: 1 }, { unique: true });
offerRequestSchema.index(
  { candidateSubdocumentId: 1 },
  { unique: true, partialFilterExpression: { isOpen: true } },
);
offerRequestSchema.index({ currentStatus: 1, createdAt: -1 });
offerRequestSchema.index({ currentAssigneeUserId: 1, currentStatus: 1 });
offerRequestSchema.index({ responsibleTeamLeadUserId: 1, currentStatus: 1 });
offerRequestSchema.index({ initiatedByUserId: 1, createdAt: -1 });

const OfferRequest = mongoose.model('OfferRequest', offerRequestSchema, 'offer_requests');

module.exports = OfferRequest;
