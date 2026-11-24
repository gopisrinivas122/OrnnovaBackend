const assert = require('assert');
const { calculateCommercials, parseMoney, roundMoney, annualToMonthly, resolveMonthlyCtcCost } = require('./offerFinance.service');

assert.strictEqual(roundMoney(10.1 + 20.2), 30.3);
assert.strictEqual(parseMoney('12.345', 'Amount'), 12.35);
assert.throws(() => parseMoney(-5, 'Amount'), /cannot be negative/);
assert.throws(() => parseMoney('abc', 'Amount'), /valid number/);
assert.strictEqual(parseMoney('', 'Amount'), null);
assert.strictEqual(annualToMonthly(600000), 50000);
assert.strictEqual(annualToMonthly(1000000), 83333.33);
assert.strictEqual(annualToMonthly(null), null);
assert.strictEqual(resolveMonthlyCtcCost(600000, 1), 50000);
assert.strictEqual(resolveMonthlyCtcCost(null, 40), 40);

const zero = calculateCommercials({
  classification: 'Billable',
  monthlyBillingRate: 0,
  monthlyCtcCost: 25,
  employerPfEsiCost: 5,
  otherApprovedMonthlyCosts: 1,
});
assert.strictEqual(zero.monthlyTotalCost, 25);
assert.strictEqual(zero.monthlyMargin, null);
assert.strictEqual(zero.marginPercentage, null);
assert.strictEqual(zero.marginStatus, 'not_applicable');

const negative = calculateCommercials({
  classification: 'Billable',
  monthlyBillingRate: 50,
  monthlyCtcCost: 80,
  employerPfEsiCost: 20,
  otherApprovedMonthlyCosts: 5,
});
assert.strictEqual(negative.monthlyTotalCost, 80);
assert.strictEqual(negative.monthlyMargin, -30);
assert.strictEqual(negative.marginPercentage, -60);
assert.strictEqual(negative.marginStatus, 'calculated');

const example = calculateCommercials({
  classification: 'Billable',
  monthlyBillingRate: 150000,
  monthlyCtcCost: annualToMonthly(1000000),
  employerPfEsiCost: 8000,
  otherApprovedMonthlyCosts: 2000,
});
assert.strictEqual(example.monthlyCtcCost, 83333.33);
assert.strictEqual(example.monthlyTotalCost, 83333.33);
assert.strictEqual(example.monthlyMargin, 66666.67);
assert.strictEqual(example.marginPercentage, 44.44);
assert.strictEqual(example.employerPfEsiCost, 8000);
assert.strictEqual(example.otherApprovedMonthlyCosts, 2000);
assert.strictEqual(example.marginStatus, 'calculated');
assert.strictEqual(example.calculationVersion, 'offer-finance-v3');

const pfChange = calculateCommercials({
  monthlyBillingRate: 150000,
  monthlyCtcCost: annualToMonthly(1000000),
  employerPfEsiCost: 10000,
  otherApprovedMonthlyCosts: 5000,
});
assert.strictEqual(pfChange.monthlyMargin, 66666.67);
assert.strictEqual(pfChange.marginPercentage, 44.44);

const emptyOptional = calculateCommercials({
  monthlyBillingRate: 100000,
  monthlyCtcCost: 50000,
  employerPfEsiCost: null,
  otherApprovedMonthlyCosts: '',
});
assert.strictEqual(emptyOptional.monthlyTotalCost, 50000);
assert.strictEqual(emptyOptional.monthlyMargin, 50000);
assert.strictEqual(emptyOptional.marginPercentage, 50);

const withBilling = calculateCommercials({
  classification: 'Administrative',
  monthlyBillingRate: 80,
  monthlyCtcCost: 10,
  employerPfEsiCost: 0,
  otherApprovedMonthlyCosts: 0,
});
assert.strictEqual(withBilling.monthlyTotalCost, 10);
assert.strictEqual(withBilling.monthlyMargin, 70);
assert.strictEqual(withBilling.marginStatus, 'calculated');

console.log('offerFinance.service.test.js passed');
