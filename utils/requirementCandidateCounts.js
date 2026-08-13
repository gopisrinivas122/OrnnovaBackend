const {
  isUploadedCandidate,
  getLatestStatus,
  isRejectedStatus,
  isActiveCandidate,
} = require('./candidateStatusMap');

function buildRequirementReqIdIndex(requirements = []) {
  const index = new Map();

  requirements.forEach((req) => {
    const canonical = req?._id?.toString?.();
    if (!canonical) return;

    index.set(canonical, canonical);

    if (req.regId != null && String(req.regId).trim() !== '') {
      index.set(String(req.regId).trim(), canonical);
    }
  });

  return index;
}

function resolveCanonicalReqId(rawReqId, reqIdIndex = new Map()) {
  const raw = rawReqId?.toString?.() || String(rawReqId || '').trim();
  if (!raw) return '';
  return reqIdIndex.get(raw) || raw;
}

function groupCandidateDocsByRequirement(candidateDocs = [], reqIdIndex = new Map()) {
  const grouped = {};

  candidateDocs.forEach((doc) => {
    const canonical = resolveCanonicalReqId(doc?.reqId, reqIdIndex);
    if (!canonical) return;

    if (!grouped[canonical]) grouped[canonical] = [];
    grouped[canonical].push(doc);
  });

  return grouped;
}

function collectUploadedCandidates(relatedDocuments = []) {
  return relatedDocuments.reduce((acc, doc) => {
    const uploaded = (doc.candidates || []).filter(isUploadedCandidate);
    return acc.concat(uploaded);
  }, []);
}

function summarizeRequirementCandidates(relatedDocuments = []) {
  const uploadedCandidates = collectUploadedCandidates(relatedDocuments);
  const rejectedCandidates = uploadedCandidates.filter((candidate) =>
    isRejectedStatus(getLatestStatus(candidate))
  );
  const activeCandidates = uploadedCandidates.filter(isActiveCandidate);

  const noactionCandidates = activeCandidates.filter((candidate) =>
    !candidate.Status
    || candidate.Status.length === 0
    || candidate.Status.every((status) => !status?.Status)
    || getLatestStatus(candidate) === 'No Action Taken'
  );

  const actionTakenCandidates = activeCandidates.filter((candidate) =>
    Array.isArray(candidate.Status)
    && candidate.Status.length > 0
    && candidate.Status.some((status) => status?.Status)
    && getLatestStatus(candidate) !== 'No Action Taken'
  );

  return {
    uploadedCandidates,
    uploadedCandidatesCount: uploadedCandidates.length,
    rejectedCandidates,
    rejectedCandidatesCount: rejectedCandidates.length,
    activeCandidates,
    activeCandidatesCount: activeCandidates.length,
    noactionCandidates,
    noactionCandidatesCount: noactionCandidates.length,
    actionTakenCandidatesCount: actionTakenCandidates.length,
  };
}

function buildCandidateReqIdValues(reqId, requirement = null) {
  const values = new Set();

  if (reqId != null && String(reqId).trim() !== '') {
    values.add(String(reqId).trim());
  }

  if (requirement) {
    if (requirement._id) values.add(requirement._id.toString());
    if (requirement.regId != null && String(requirement.regId).trim() !== '') {
      values.add(String(requirement.regId).trim());
    }
  }

  return [...values];
}

module.exports = {
  buildRequirementReqIdIndex,
  resolveCanonicalReqId,
  groupCandidateDocsByRequirement,
  collectUploadedCandidates,
  summarizeRequirementCandidates,
  buildCandidateReqIdValues,
};
