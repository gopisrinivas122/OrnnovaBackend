function normalizeSourceProfileNameQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function candidateMatchesSourceProfileName(candidate, rawQuery) {
  const query = normalizeSourceProfileNameQuery(rawQuery);
  if (!query) return false;

  const first = String(candidate?.firstName || '').trim().toLowerCase();
  const last = String(candidate?.lastName || '').trim().toLowerCase();
  const full = `${first} ${last}`.trim().replace(/\s+/g, ' ');

  return first.includes(query) || last.includes(query) || full.includes(query);
}

module.exports = {
  normalizeSourceProfileNameQuery,
  candidateMatchesSourceProfileName,
};
