const CandidateModel = require('../models/Candidate');
const NewRequirment = require('../models/Requirement');
const NewUser = require('../models/User');
const { isValidObjectId } = require('../middleware/validateObjectId');
const { serializeCandidateStatusHistory } = require('../utils/statusRemarks');

function parseDateBoundary(value, endOfDay = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }
  return date;
}

function isUploadedOnInRange(uploadedOn, startDate, endDate) {
  if (!uploadedOn) return false;
  const date = new Date(uploadedOn);
  if (Number.isNaN(date.getTime())) return false;

  const from = parseDateBoundary(startDate, false);
  const to = parseDateBoundary(endDate, true);

  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function candidateOwnedByUser(candidate, docRecruiterIds, userId) {
  const uid = String(userId);
  const candidateRecruiters = Array.isArray(candidate?.recruiterId)
    ? candidate.recruiterId.map(String)
    : [];
  if (candidateRecruiters.includes(uid)) return true;
  return (docRecruiterIds || []).map(String).includes(uid);
}

async function getMySourcedProfiles(authenticatedUserId, { startDate, endDate } = {}) {
  const user = await NewUser.findById(authenticatedUserId).select('_id UserType').lean();
  if (!user) {
    return { status: 'Error', msg: 'User not found', profiles: [] };
  }

  if (user.UserType === 'Admin') {
    return {
      status: 'Success',
      profiles: [],
      period: { startDate: startDate || null, endDate: endDate || null },
    };
  }

  const userId = String(user._id);
  const candidateDocs = await CandidateModel.find({ recruiterId: userId }).lean();

  const pendingProfiles = [];
  const requirementKeys = new Set();

  candidateDocs.forEach((doc) => {
    const docRecruiterIds = Array.isArray(doc.recruiterId) ? doc.recruiterId : [];
    (doc.candidates || []).forEach((candidate) => {
      if (candidate.savedStatus !== 'Uploaded') return;
      if (!candidateOwnedByUser(candidate, docRecruiterIds, userId)) return;

      const uploadedOn = candidate.uploadedOn || candidate.date;
      if (!isUploadedOnInRange(uploadedOn, startDate, endDate)) return;

      const serialized = serializeCandidateStatusHistory(candidate);
      const reqKey = String(doc.reqId || '').trim();
      if (reqKey) requirementKeys.add(reqKey);

      pendingProfiles.push({
        profileId: String(serialized._id),
        requirementKey: reqKey,
        role: serialized.role || '',
        candidateName: `${serialized.firstName || ''} ${serialized.lastName || ''}`.trim() || '—',
        status: serialized.currentStatus || 'No Action Taken',
        phone: serialized.mobileNumber || '—',
        sourcedDate: uploadedOn ? new Date(uploadedOn).toISOString() : null,
      });
    });
  });

  const keys = [...requirementKeys];
  const objectIdKeys = keys.filter((key) => isValidObjectId(key));
  const regIdKeys = keys.filter((key) => !isValidObjectId(key));

  const requirements = await NewRequirment.find({
    $or: [
      ...(objectIdKeys.length ? [{ _id: { $in: objectIdKeys } }] : []),
      ...(regIdKeys.length ? [{ regId: { $in: regIdKeys } }] : []),
    ],
  }).select('_id regId client role').lean();

  const requirementByKey = new Map();
  requirements.forEach((req) => {
    requirementByKey.set(String(req._id), req);
    requirementByKey.set(String(req.regId), req);
  });

  const profiles = pendingProfiles
    .map((row) => {
      const req = requirementByKey.get(row.requirementKey);
      return {
        profileId: row.profileId,
        requirementId: req ? String(req._id) : row.requirementKey,
        client: req?.client || '—',
        role: row.role || req?.role || '—',
        candidateName: row.candidateName,
        status: row.status,
        phone: row.phone,
        sourcedDate: row.sourcedDate,
      };
    })
    .sort((a, b) => new Date(b.sourcedDate || 0) - new Date(a.sourcedDate || 0));

  return {
    status: 'Success',
    profiles,
    period: {
      startDate: startDate || null,
      endDate: endDate || null,
    },
  };
}

module.exports = {
  getMySourcedProfiles,
};
