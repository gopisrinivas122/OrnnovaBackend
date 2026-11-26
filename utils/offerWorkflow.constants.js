const OFFER_STATUSES = [
  'Initiated',
  'TL Review',
  'HR Review',
  'Returned to TL',
  'MD Review',
  'Returned to HR',
  'Returned to TL by MD',
  'MD Approved',
  'Admin Review',
  'Returned by Admin',
  'Letter Preparation Requested',
  'Letter Generated',
  'Offer Released',
  'Offer Accepted',
  'Candidate Declined',
  'Onboard Confirmation',
  'Joined',
  'Cancelled',
];

/** Closed requests do not block a later offer for the same candidate. */
const CLOSED_OFFER_STATUSES = ['Cancelled', 'Joined', 'Candidate Declined'];

const ELIGIBLE_INITIATION_STATUS = 'Offer to be released';

const DOCUMENT_TYPES = [
  'aadhaar',
  'pan',
  'photograph',
  'resume',
  'education_certificate',
  'address_proof',
  'experience_document',
  'other',
];

const REQUIRED_DOCUMENT_TYPES = [
  'aadhaar',
  'pan',
  'photograph',
  'resume',
  'education_certificate',
  'address_proof',
];

const EXPERIENCED_DOCUMENT_TYPES = ['experience_document'];

const VERIFICATION_STATUSES = ['Pending', 'Verified', 'Rejected'];

const EMPLOYMENT_CATEGORIES = ['Fresher', 'Experienced'];
const CLASSIFICATIONS = ['Billable', 'Administrative'];
const WORK_MODES = ['Onsite', 'Hybrid', 'Remote'];

const FINANCE_CALCULATION_VERSION = 'offer-finance-v3';

const HR_INBOX_STATUSES = [
  'HR Review',
  'Returned to HR',
];

const HR_RELEASE_STATUSES = [
  'Letter Preparation Requested',
  'Letter Generated',
];

const HR_READ_STATUSES = [
  ...HR_INBOX_STATUSES,
  ...HR_RELEASE_STATUSES,
  'Offer Released',
  'Offer Accepted',
  'Candidate Declined',
  'Onboard Confirmation',
  'Joined',
];

const TL_EDIT_STATUSES = [
  'Initiated',
  'TL Review',
  'Returned to TL',
  'Returned to TL by MD',
];

const ADMIN_APPROVAL_STATUSES = [
  'Admin Review',
  'MD Review',
  'MD Approved',
];

const OFFER_STAGE_IDS = {
  initiation: 'initiation',
  tlReview: 'tl_review',
  hrVerification: 'hr_verification',
  adminApproval: 'admin_approval',
  offerRelease: 'offer_release',
};

const OFFER_STAGE_LABELS = {
  initiation: 'Initiation',
  tl_review: 'TL Review',
  hr_verification: 'HR Verification',
  admin_approval: 'Admin Approval',
  offer_release: 'Offer Release',
};

const OFFER_STATUS_DISPLAY_LABELS = {
  Initiated: 'Pending TL Review',
  'TL Review': 'Pending TL Review',
  'Returned to TL': 'Pending TL Review',
  'Returned to TL by MD': 'Pending TL Review',
  'HR Review': 'Pending HR Verification',
  'Returned to HR': 'Pending HR Verification',
  'Admin Review': 'Pending Admin Approval',
  'MD Review': 'Pending Admin Approval',
  'MD Approved': 'Pending Admin Approval',
  'Returned by Admin': 'Returned by Admin',
  'Letter Preparation Requested': 'Approved – Awaiting HR',
  'Letter Generated': 'Offer Generation in Progress',
  'Offer Released': 'Offer Released',
};

const POST_OFFER_ACTOR_ROLES = ['Admin', 'HR', 'TeamLead'];

function isClosedOfferStatus(status) {
  return CLOSED_OFFER_STATUSES.includes(status);
}

function isOpenOfferStatus(status) {
  return OFFER_STATUSES.includes(status) && !isClosedOfferStatus(status);
}

function isTlStageSkipped(offer = {}) {
  return offer.tlStageSkipped === true
    || offer.initiationRoute === 'direct_hr'
    || offer.initiationRoute === 'DIRECT_TO_HR';
}

function offerWorkflowStageId(offer = {}) {
  const status = offer.currentStatus || '';
  if (['Letter Preparation Requested', 'Letter Generated', 'Offer Released', 'Offer Accepted', 'Onboard Confirmation', 'Joined'].includes(status)) {
    return OFFER_STAGE_IDS.offerRelease;
  }
  if (ADMIN_APPROVAL_STATUSES.includes(status)) return OFFER_STAGE_IDS.adminApproval;
  if (HR_INBOX_STATUSES.includes(status)) return OFFER_STAGE_IDS.hrVerification;
  if (TL_EDIT_STATUSES.includes(status)) {
    return isTlStageSkipped(offer) ? OFFER_STAGE_IDS.hrVerification : OFFER_STAGE_IDS.tlReview;
  }
  if (status === 'Returned by Admin') {
    if (offer.currentAssigneeRole === 'TeamLead') return OFFER_STAGE_IDS.tlReview;
    if (offer.currentAssigneeRole === 'HR') return OFFER_STAGE_IDS.hrVerification;
    return OFFER_STAGE_IDS.adminApproval;
  }
  if (status === 'Cancelled') return OFFER_STAGE_IDS.initiation;
  return OFFER_STAGE_IDS.initiation;
}

function offerStatusDisplayLabel(status) {
  return OFFER_STATUS_DISPLAY_LABELS[status] || status || '';
}

module.exports = {
  OFFER_STATUSES,
  CLOSED_OFFER_STATUSES,
  ELIGIBLE_INITIATION_STATUS,
  DOCUMENT_TYPES,
  REQUIRED_DOCUMENT_TYPES,
  EXPERIENCED_DOCUMENT_TYPES,
  VERIFICATION_STATUSES,
  EMPLOYMENT_CATEGORIES,
  CLASSIFICATIONS,
  WORK_MODES,
  FINANCE_CALCULATION_VERSION,
  HR_INBOX_STATUSES,
  HR_RELEASE_STATUSES,
  HR_READ_STATUSES,
  TL_EDIT_STATUSES,
  ADMIN_APPROVAL_STATUSES,
  OFFER_STAGE_IDS,
  OFFER_STAGE_LABELS,
  OFFER_STATUS_DISPLAY_LABELS,
  POST_OFFER_ACTOR_ROLES,
  isClosedOfferStatus,
  isOpenOfferStatus,
  isTlStageSkipped,
  offerWorkflowStageId,
  offerStatusDisplayLabel,
};
