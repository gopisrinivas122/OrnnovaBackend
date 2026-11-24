const { FINANCE_CALCULATION_VERSION } = require('../utils/offerWorkflow.constants');

const MAX_MONEY = 999999999.99;

class OfferFinanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OfferFinanceError';
    this.isOfferWorkflowError = true;
    this.statusCode = 400;
    this.code = 'INVALID_FINANCIAL_VALUE';
  }
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return null;
  const sign = value < 0 ? -1 : 1;
  const cents = Math.round((Math.abs(value) * 100) + 1e-8);
  return (sign * cents) / 100;
}

function parseMoney(value, label, { required = false, positive = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new OfferFinanceError(`${label} is required`);
    return null;
  }

  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric)) {
    throw new OfferFinanceError(`${label} must be a valid number`);
  }
  if (positive && numeric <= 0) {
    throw new OfferFinanceError(`${label} must be a positive amount`);
  }
  if (numeric < 0) {
    throw new OfferFinanceError(`${label} cannot be negative`);
  }
  if (numeric > MAX_MONEY) {
    throw new OfferFinanceError(`${label} is too large`);
  }
  return roundMoney(numeric);
}

function annualToMonthly(annual) {
  const amount = parseMoney(annual, 'Candidate Agreed Annual CTC');
  if (amount === null) return null;
  return roundMoney(amount / 12);
}

function resolveMonthlyCtcCost(candidateAgreedAnnualCtc, monthlyCtcCost) {
  if (candidateAgreedAnnualCtc !== null && candidateAgreedAnnualCtc !== undefined && candidateAgreedAnnualCtc !== '') {
    return annualToMonthly(candidateAgreedAnnualCtc);
  }
  return monthlyCtcCost;
}

/**
 * Margin = Monthly Billing Rate − Candidate Monthly Cost.
 * Employer PF/ESI and Other Monthly Costs are not part of the active workflow; any stored
 * historical values are ignored for margin and monthlyTotalCost.
 */
function calculateCommercials({
  monthlyBillingRate,
  monthlyCtcCost,
  employerPfEsiCost,
  otherApprovedMonthlyCosts,
} = {}) {
  const billing = parseMoney(monthlyBillingRate, 'Monthly billing rate');
  const ctcCost = parseMoney(monthlyCtcCost, 'Monthly CTC cost');
  const pfEsi = parseMoney(employerPfEsiCost, 'Employer PF/ESI cost');
  const otherCosts = parseMoney(otherApprovedMonthlyCosts, 'Other approved monthly costs');

  const monthlyTotalCost = ctcCost == null ? 0 : ctcCost;

  const base = {
    monthlyBillingRate: billing,
    monthlyCtcCost: ctcCost,
    employerPfEsiCost: pfEsi,
    otherApprovedMonthlyCosts: otherCosts,
    monthlyTotalCost,
    calculationVersion: FINANCE_CALCULATION_VERSION,
  };

  const billingMissingOrZero = billing === null || billing === 0;
  if (billingMissingOrZero) {
    return {
      ...base,
      monthlyMargin: null,
      marginPercentage: null,
      marginStatus: 'not_applicable',
    };
  }

  const costBasis = ctcCost == null ? 0 : ctcCost;
  const monthlyMargin = roundMoney(billing - costBasis);
  const marginPercentage = roundMoney((monthlyMargin / billing) * 100);

  return {
    ...base,
    monthlyMargin,
    marginPercentage,
    marginStatus: 'calculated',
  };
}

module.exports = {
  OfferFinanceError,
  MAX_MONEY,
  roundMoney,
  parseMoney,
  annualToMonthly,
  resolveMonthlyCtcCost,
  calculateCommercials,
};
