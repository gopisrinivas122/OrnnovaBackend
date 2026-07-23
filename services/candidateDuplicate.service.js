const NewRequirment = require('../models/Requirement');
const CandidateModel = require('../models/Candidate');

function normalizeEmail(email = '') {
  return String(email).trim().toLowerCase();
}

function normalizeMobile(mobile = '') {
  return String(mobile).replace(/\D/g, '');
}

async function resolveClientId({ clientId, reqId }) {
  if (clientId) return clientId.toString();
  if (!reqId) return null;
  const requirement = await NewRequirment.findById(reqId).select('clientId').lean();
  return requirement?.clientId?.toString() || null;
}

async function checkDuplicateCandidate({ email, mobileNumber, clientId, reqId, excludeCandidateId }) {
  const resolvedClientId = await resolveClientId({ clientId, reqId });

  if (!resolvedClientId || !email || !mobileNumber) {
    return { isDuplicate: false };
  }

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const normalizedEmail = normalizeEmail(email);
  const normalizedMobile = normalizeMobile(mobileNumber);

  const candidateDocs = await CandidateModel.find().lean();
  const requirementIds = [...new Set(candidateDocs.map((doc) => doc.reqId).filter(Boolean))];
  const requirements = await NewRequirment.find({ _id: { $in: requirementIds } })
    .select('clientId client')
    .lean();

  const clientByReqId = new Map(
    requirements.map((req) => [req._id.toString(), req.clientId?.toString()])
  );

  for (const doc of candidateDocs) {
    const docClientId = clientByReqId.get(doc.reqId?.toString());
    if (docClientId !== resolvedClientId) continue;

    for (const candidate of doc.candidates || []) {
      if (excludeCandidateId && candidate._id?.toString() === excludeCandidateId.toString()) continue;
      if (normalizeEmail(candidate.email) !== normalizedEmail) continue;
      if (normalizeMobile(candidate.mobileNumber) !== normalizedMobile) continue;

      const uploadedOn = new Date(candidate.uploadedOn || candidate.date);
      if (Number.isNaN(uploadedOn.getTime()) || uploadedOn < sixMonthsAgo) continue;

      const requirement = requirements.find((req) => req._id.toString() === doc.reqId?.toString());

      return {
        isDuplicate: true,
        message:
          'This candidate (same Mobile Number + Email ID) was already submitted for this client within the last 6 months.',
        match: {
          candidateName: `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim(),
          client: requirement?.client || '—',
          uploadedOn,
          reqId: doc.reqId,
        },
      };
    }
  }

  return { isDuplicate: false };
}

module.exports = {
  checkDuplicateCandidate,
  normalizeEmail,
  normalizeMobile,
};
