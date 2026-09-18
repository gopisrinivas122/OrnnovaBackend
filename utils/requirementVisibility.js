const { getRequirementsForTeamLead } = require('./teamLeadRequirements');

async function getVisibleRequirementsForTeamLead(user, options = {}) {
  return getRequirementsForTeamLead(user, {
    lean: options.lean !== false,
    withSource: false,
  });
}

async function getVisibleRequirementsForRecruiter(user, options = {}) {
  if (!user) return [];

  const assignedIds = (user.Requirements || []).map((id) => id.toString()).filter(Boolean);
  if (!assignedIds.length) return [];

  const query = NewRequirment.find({ _id: { $in: assignedIds } });
  if (options.lean) query.lean();
  return query.exec();
}

function canTeamLeadManageRequirement(user, requirement) {
  if (!user || !requirement) return false;
  if (user.UserType === 'Admin') return true;
  if (user.UserType !== 'TeamLead') return false;
  return getCreatedBy(requirement) === user._id.toString();
}

module.exports = {
  getVisibleRequirementsForTeamLead,
  getVisibleRequirementsForRecruiter,
  canTeamLeadManageRequirement,
};
