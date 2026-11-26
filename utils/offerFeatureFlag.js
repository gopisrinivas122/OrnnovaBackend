function isOfferWorkflowEnabled() {
  const value = String(process.env.OFFER_WORKFLOW_ENABLED || '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

module.exports = { isOfferWorkflowEnabled };
