/**
 * Whether a candidate profile was sourced/uploaded by the given user.
 * Uses per-candidate recruiterId; falls back to parent document recruiterId for legacy rows.
 */
function candidateOwnedByUser(candidate, docRecruiterIds, userId) {
  const uid = String(userId);
  const candidateRecruiters = Array.isArray(candidate?.recruiterId)
    ? candidate.recruiterId.map(String)
    : [];
  if (candidateRecruiters.includes(uid)) return true;
  return (docRecruiterIds || []).map(String).includes(uid);
}

module.exports = {
  candidateOwnedByUser,
};
