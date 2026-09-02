const NewUser = require('../models/User');
const { isValidObjectId } = require('../middleware/validateObjectId');

function getRequirementCreatorId(requirement = {}) {
  return String(requirement.createdBy || requirement.uploadedBy || '').trim();
}

function buildCreatorInfoMap(users = []) {
  return users.reduce((acc, user) => {
    const id = user?._id?.toString();
    if (!id) return acc;
    acc[id] = {
      name: user.EmployeeName || '—',
      userType: user.UserType || '',
    };
    return acc;
  }, {});
}

async function buildCreatorInfoMapForRequirements(requirements = []) {
  const creatorIds = [...new Set(
    requirements
      .map((requirement) => getRequirementCreatorId(requirement))
      .filter((id) => id && isValidObjectId(id))
  )];

  if (!creatorIds.length) return {};

  const users = await NewUser.find({ _id: { $in: creatorIds } })
    .select('_id EmployeeName UserType')
    .lean();

  return buildCreatorInfoMap(users);
}

function attachCreatorInfo(requirement = {}, creatorInfoMap = {}) {
  const creatorId = getRequirementCreatorId(requirement);
  const creatorInfo = creatorInfoMap[creatorId] || { name: '—', userType: '' };

  return {
    ...(requirement?.toObject ? requirement.toObject() : { ...requirement }),
    creatorName: creatorInfo.name,
    creatorUserType: creatorInfo.userType,
    requirementSource: creatorInfo.name,
  };
}

module.exports = {
  getRequirementCreatorId,
  buildCreatorInfoMap,
  buildCreatorInfoMapForRequirements,
  attachCreatorInfo,
};
