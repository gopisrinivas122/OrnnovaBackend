const NewRequirment = require('../models/Requirement');
const NewClient = require('../models/Client');
const NewUser = require('../models/User');
const { activeUserFilter } = require('./userStatus');
const { isValidObjectId } = require('../middleware/validateObjectId');

const SOURCE_LABELS = {
  TL_CREATED: 'TL Created',
  CLIENT_ASSIGNED: 'Client Assigned',
  ADMIN_CREATED: 'Admin Created',
  ASSIGNED: 'Assigned',
};

function uniqueRequirements(requirements = []) {
  const byId = new Map();
  requirements.forEach((req) => {
    if (req?._id) byId.set(req._id.toString(), req);
  });
  return Array.from(byId.values());
}

async function getTeamLeadClientContext(user) {
  const clientIds = user?.Clients || [];
  const clientIdStrings = clientIds.map((id) => id.toString());

  let clientNames = [];
  if (clientIds.length) {
    const clients = await NewClient.find({ _id: { $in: clientIds } })
      .select('ClientName')
      .lean();
    clientNames = clients.map((client) => client.ClientName).filter(Boolean);
  }

  return { clientIds, clientIdStrings, clientNames };
}

function matchesAssignedClient(requirement, clientIdStrings = [], clientNames = []) {
  const reqClientId = String(requirement?.clientId || '');
  if (reqClientId && clientIdStrings.includes(reqClientId)) {
    return true;
  }

  const reqClientName = String(requirement?.client || '').trim().toLowerCase();
  if (!reqClientName) return false;

  return clientNames.some(
    (name) => String(name || '').trim().toLowerCase() === reqClientName
  );
}

function classifyRequirementSource(requirement, context = {}) {
  const {
    userId = '',
    clientIdStrings = [],
    clientNames = [],
    directRequirementIds = [],
    uploaderTypeMap = {},
  } = context;

  const reqId = requirement?._id?.toString() || '';
  const uploadedBy = String(requirement?.uploadedBy || '');

  if (uploadedBy && uploadedBy === userId) {
    return SOURCE_LABELS.TL_CREATED;
  }

  if (matchesAssignedClient(requirement, clientIdStrings, clientNames)) {
    return SOURCE_LABELS.CLIENT_ASSIGNED;
  }

  const uploaderType = uploaderTypeMap[uploadedBy];
  if (uploaderType === 'Admin') {
    return SOURCE_LABELS.ADMIN_CREATED;
  }

  if (directRequirementIds.includes(reqId)) {
    return SOURCE_LABELS.ASSIGNED;
  }

  return SOURCE_LABELS.ADMIN_CREATED;
}

async function buildUploaderTypeMap(requirements = []) {
  const uploaderIds = [...new Set(
    requirements
      .map((req) => String(req?.uploadedBy || ''))
      .filter((id) => id && isValidObjectId(id))
  )];

  if (!uploaderIds.length) return {};

  const uploaders = await NewUser.find({ _id: { $in: uploaderIds } })
    .select('_id UserType')
    .lean();

  return uploaders.reduce((acc, user) => {
    acc[user._id.toString()] = user.UserType;
    return acc;
  }, {});
}

async function getAdminUploaderIds() {
  const admins = await NewUser.find({ UserType: 'Admin' }).select('_id').lean();
  return admins.map((admin) => admin._id.toString());
}

async function getRequirementsForTeamLead(user, { lean = false, withSource = false } = {}) {
  if (!user) return [];

  const userId = user._id.toString();
  const assignedIds = (user.Requirements || []).map((id) => id.toString()).filter(Boolean);

  const orConditions = [{ uploadedBy: userId }];
  if (assignedIds.length) {
    orConditions.push({ _id: { $in: assignedIds } });
  }

  const query = NewRequirment.find({ $or: orConditions });
  if (lean) query.lean();
  const results = await query.exec();
  const unique = uniqueRequirements(results);

  if (!withSource) return unique;

  const uploaderTypeMap = await buildUploaderTypeMap(unique);
  const sourceContext = {
    userId,
    clientIdStrings: [],
    clientNames: [],
    directRequirementIds: assignedIds,
    uploaderTypeMap,
  };

  return unique.map((requirement) => {
    const plainRequirement = requirement?.toObject ? requirement.toObject() : { ...requirement };
    const source = classifyRequirementSource(plainRequirement, sourceContext);
    return {
      ...plainRequirement,
      requirementSource: plainRequirement.uploadedBy === userId
        ? SOURCE_LABELS.TL_CREATED
        : source,
    };
  });
}

async function attachRequirementToTeamLead(userId, requirementId) {
  if (!userId || !requirementId) return;

  const user = await NewUser.findById(userId);
  if (!user || user.UserType !== 'TeamLead') return;

  const reqIdStr = requirementId.toString();
  const alreadyLinked = (user.Requirements || []).some((id) => id.toString() === reqIdStr);
  if (alreadyLinked) return;

  user.Requirements.push(requirementId);
  await user.save();
}

async function linkRequirementToMatchingTeamLeads(requirement) {
  const requirementId = requirement?._id;
  const clientId = requirement?.clientId ? String(requirement.clientId) : '';
  if (!requirementId) return;

  const teamLeads = clientId
    ? await NewUser.find({ UserType: 'TeamLead', Clients: clientId }).select('_id')
    : await NewUser.find({ UserType: 'TeamLead' }).select('_id');

  await Promise.all(
    teamLeads.map((teamLead) => attachRequirementToTeamLead(teamLead._id, requirementId))
  );
}

async function getRequirementsForUser(user, { lean = true } = {}) {
  if (!user) return [];

  const assignedIds = (user.Requirements || []).map((id) => id.toString()).filter(Boolean);
  if (!assignedIds.length) return [];

  const query = NewRequirment.find({ _id: { $in: assignedIds } });
  if (lean) query.lean();
  return query.exec();
}

async function userCanAccessRequirement(user, requirement) {
  if (!user || !requirement) return false;

  const userId = user._id.toString();
  const requirementId = requirement._id.toString();

  if (user.UserType === 'Admin') return true;

  if (user.UserType === 'TeamLead') {
    return String(requirement.uploadedBy || requirement.createdBy || '') === userId
      || (user.Requirements || []).some((id) => id.toString() === requirementId);
  }

  return (user.Requirements || []).some((id) => id.toString() === requirementId);
}

module.exports = {
  SOURCE_LABELS,
  getTeamLeadClientContext,
  classifyRequirementSource,
  getRequirementsForTeamLead,
  getRequirementsForUser,
  userCanAccessRequirement,
  attachRequirementToTeamLead,
  linkRequirementToMatchingTeamLeads,
  matchesAssignedClient,
};
