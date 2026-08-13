const NewUser = require('../models/User');
const NewRequirment = require('../models/Requirement');
const { activeUserFilter, isActiveUser } = require('../utils/userStatus');
const { sendEmailSafely } = require('../config/mail');

function parseAssignedMemberIds(rawValue) {
  if (!rawValue) return [];

  let parsed = rawValue;
  if (typeof rawValue === 'string') {
    try {
      parsed = JSON.parse(rawValue);
    } catch (error) {
      parsed = rawValue.split(',').map((id) => id.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map(String).filter(Boolean))];
}

async function assignRequirementToMembers(requirement, memberIds, assignedByUserId) {
  if (!requirement?._id || !memberIds.length) {
    return { assignedMembers: [], assignedCount: 0 };
  }

  const assignerId = assignedByUserId ? String(assignedByUserId) : '';
  const members = await NewUser.find({
    _id: { $in: memberIds },
    UserType: { $in: ['User', 'TeamLead'] },
    ...activeUserFilter,
  });

  const assignedAt = new Date();
  const assignedRecords = [];

  await Promise.all(members.map(async (member) => {
    const memberId = String(member._id);
    const reqId = String(requirement._id);
    const alreadyAssigned = (member.Requirements || []).some((id) => String(id) === reqId);

    if (!alreadyAssigned) {
      member.Requirements.push(requirement._id);
      await member.save();

      sendEmailSafely({
        from: process.env.EMAIL,
        to: member.Email,
        subject: 'Requirement Assigned To You',
        text: `Dear ${member.EmployeeName},\n\nA new requirement has been assigned to you. Please claim it before uploading profiles.\n\nCheck Here: https://ornnova.com/HR/`,
      });
    }

    assignedRecords.push({
      userId: memberId,
      userType: member.UserType,
      employeeName: member.EmployeeName,
      email: member.Email,
      assignedDate: assignedAt,
    });
  }));

  requirement.assignedBy = assignerId || requirement.assignedBy || '';
  requirement.assignedMembers = assignedRecords;
  requirement.claimStatus = requirement.claimStatus || 'Assigned';
  requirement.update = 'Old';
  await requirement.save();

  return {
    assignedMembers: assignedRecords,
    assignedCount: assignedRecords.length,
  };
}

async function getAssignableMembers() {
  return NewUser.find({
    UserType: { $in: ['User', 'TeamLead'] },
    ...activeUserFilter,
  })
    .select('_id EmployeeName Email UserType EmpCode Status')
    .sort({ EmployeeName: 1 })
    .lean();
}

function isMemberAssigned(requirement, userId) {
  if (!requirement || !userId) return false;
  const uid = String(userId);
  return (requirement.assignedMembers || []).some((member) => String(member.userId) === uid);
}

module.exports = {
  parseAssignedMemberIds,
  assignRequirementToMembers,
  getAssignableMembers,
  isMemberAssigned,
};
