const CandidateModel = require('../models/Candidate');
const {
  getRequirementsForTeamLead,
  getRequirementsForUser,
} = require('./teamLeadRequirements');
const { normalizeRequirementPriority } = require('./requirementPriority');

async function countUploadedProfilesForRequirement(reqId, { recruiterId = null } = {}) {
  const query = { reqId: String(reqId) };
  if (recruiterId) {
    query.recruiterId = String(recruiterId);
  }

  const documents = await CandidateModel.find(query).select('candidates').lean();
  return documents.reduce((total, doc) => {
    const uploaded = (doc.candidates || []).filter(
      (candidate) => candidate.savedStatus === 'Uploaded',
    );
    return total + uploaded.length;
  }, 0);
}

async function getPriorityProfileReminderStatus(user) {
  if (!user) {
    return { shouldRemind: false, missingCount: 0, missingRequirements: [] };
  }

  let requirements = [];
  const scope = {};

  if (user.UserType === 'User') {
    requirements = await getRequirementsForUser(user, { lean: true });
    scope.recruiterId = String(user._id);
  } else if (user.UserType === 'TeamLead') {
    requirements = await getRequirementsForTeamLead(user, { withSource: true, lean: true });
  } else {
    return { shouldRemind: false, missingCount: 0, missingRequirements: [] };
  }

  const priorityRequirements = requirements.filter((req) => {
    const normalized = normalizeRequirementPriority(req.priority);
    return normalized !== null && normalized !== undefined;
  });

  if (!priorityRequirements.length) {
    return { shouldRemind: false, missingCount: 0, missingRequirements: [] };
  }

  const missingRequirements = [];

  for (const req of priorityRequirements) {
    const profileCount = await countUploadedProfilesForRequirement(req._id, scope);
    if (profileCount === 0) {
      missingRequirements.push({
        reqId: String(req._id),
        regId: req.regId || '',
        priority: normalizeRequirementPriority(req.priority),
      });
    }
  }

  return {
    shouldRemind: missingRequirements.length > 0,
    missingCount: missingRequirements.length,
    missingRequirements,
  };
}

module.exports = {
  countUploadedProfilesForRequirement,
  getPriorityProfileReminderStatus,
};
