const assert = require('assert');
const {
  normalizeSourceProfileNameQuery,
  candidateMatchesSourceProfileName,
} = require('./sourceProfileNameMatch');

assert.strictEqual(normalizeSourceProfileNameQuery('  John   Doe  '), 'john doe');
assert.strictEqual(normalizeSourceProfileNameQuery(''), '');

const candidate = { firstName: 'Saravan', lastName: 'Kumar' };

assert.strictEqual(candidateMatchesSourceProfileName(candidate, 'sara'), true, 'partial first name');
assert.strictEqual(candidateMatchesSourceProfileName(candidate, 'KUMAR'), true, 'case-insensitive last name');
assert.strictEqual(candidateMatchesSourceProfileName(candidate, '  saravan kumar  '), true, 'padded full name');
assert.strictEqual(candidateMatchesSourceProfileName(candidate, 'van kum'), true, 'partial full name');
assert.strictEqual(candidateMatchesSourceProfileName(candidate, 'namrata'), false, 'unrelated name');
assert.strictEqual(candidateMatchesSourceProfileName(candidate, '   '), false, 'whitespace only');

console.log('sourceProfileNameMatch.test.js passed');
