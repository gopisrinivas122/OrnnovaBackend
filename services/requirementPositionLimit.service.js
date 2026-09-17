const CandidateModel = require('../models/Candidate');
const { getLatestStatus } = require('../utils/candidateStatusMap');
const { buildCandidateReqIdValues } = require('../utils/requirementCandidateCounts');

function getPositionLimit(requirement) {
  const positions = Number(requirement?.numberOfPositions);
  return Number.isFinite(positions) && positions > 0 ? positions : 1;
}

async function countJoinedCandidates(requirement) {
  if (!requirement?._id) return 0;

  const reqIdValues = buildCandidateReqIdValues(requirement._id, requirement);
  if (!reqIdValues.length) return 0;

  const docs = await CandidateModel.find({ reqId: { $in: reqIdValues } }).select('candidates').lean();
  let joinedCount = 0;

  docs.forEach((doc) => {
    (doc.candidates || []).forEach((candidate) => {
      if (getLatestStatus(candidate) === 'Joined') {
        joinedCount += 1;
      }
    });
  });

  return joinedCount;
}

async function isPositionLimitReached(requirement) {
  if (!requirement) return false;
  const joinedCount = await countJoinedCandidates(requirement);
  return joinedCount >= getPositionLimit(requirement);
}

module.exports = {
  getPositionLimit,
  countJoinedCandidates,
  isPositionLimitReached,
};
