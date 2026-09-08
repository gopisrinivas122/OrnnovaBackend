const NewUser = require('../models/User');
const { isActiveUser } = require('../utils/userStatus');
const {
  getCreatedBy,
  isUserAssignedToRequirement,
  canUserAssignRequirement,
} = require('./requirementWorkflow.service');

function normalizeId(value) {
  if (!value) return '';
  return value.toString();
}

async function canUserManageUploadStatus(actor, requirement, targetUserId) {
  if (!actor || !requirement || !targetUserId || !isActiveUser(actor)) {
    return false;
  }

  const targetUser = await NewUser.findById(targetUserId);
  if (!targetUser || !isUserAssignedToRequirement(targetUser, requirement._id)) {
    return false;
  }

  if (actor.UserType === 'Admin') {
    return true;
  }

  if (actor.UserType !== 'TeamLead') {
    return false;
  }

  if (targetUser.UserType === 'TeamLead') {
    return false;
  }

  const actorId = actor._id.toString();
  const isCreator = getCreatedBy(requirement) === actorId;
  const canAssign = await canUserAssignRequirement(actor, requirement);

  if (!isCreator && !canAssign) {
    return false;
  }

  const teamIds = (actor.Team || []).map((id) => normalizeId(id));
  return teamIds.includes(normalizeId(targetUserId));
}

module.exports = {
  canUserManageUploadStatus,
};
