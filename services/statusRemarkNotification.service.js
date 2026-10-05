const NewUser = require('../models/User');
const NewRequirment = require('../models/Requirement');
const NotificationModel = require('../models/Notification');
const { activeUserFilter, isActiveUser } = require('../utils/userStatus');
const { getRequirementCreatorId } = require('../utils/requirementCreator');
const { enrichRequirementWithClientName } = require('../utils/requirementClient');
const logger = require('../utils/logger');

function normalizeId(value) {
  if (!value) return '';
  return String(value).trim();
}

function resolveProfileOwnerUserIds(candidate, mainDocument) {
  const ids = new Set();
  (candidate?.recruiterId || []).forEach((id) => {
    const uid = normalizeId(id);
    if (uid) ids.add(uid);
  });
  (mainDocument?.recruiterId || []).forEach((id) => {
    const uid = normalizeId(id);
    if (uid) ids.add(uid);
  });
  return [...ids];
}

async function findTeamLeadIdForMember(memberUserId) {
  const uid = normalizeId(memberUserId);
  if (!uid) return null;

  const teamLead = await NewUser.findOne({
    UserType: 'TeamLead',
    Team: uid,
    ...activeUserFilter,
  })
    .select('_id')
    .lean();

  return teamLead?._id ? normalizeId(teamLead._id) : null;
}

async function resolveRelevantAdminIds(requirement) {
  const candidateIds = [
    getRequirementCreatorId(requirement),
    requirement?.assignedBy,
    requirement?.uploadedBy,
  ]
    .map(normalizeId)
    .filter(Boolean);

  const uniqueIds = [...new Set(candidateIds)];
  if (!uniqueIds.length) return [];

  const admins = await NewUser.find({
    _id: { $in: uniqueIds },
    UserType: 'Admin',
    ...activeUserFilter,
  })
    .select('_id')
    .lean();

  return admins.map((user) => normalizeId(user._id));
}

/**
 * All other participants on this profile/requirement thread (bidirectional).
 * Uses a Set so each user is notified at most once per remark event.
 */
async function resolveStatusRemarkRecipients(actor, requirement, candidate, mainDocument) {
  if (!actor?._id) return [];

  const actorId = normalizeId(actor._id);
  const recipients = new Set();
  const profileOwnerIds = resolveProfileOwnerUserIds(candidate, mainDocument);

  profileOwnerIds.forEach((ownerId) => {
    recipients.add(ownerId);
  });

  await Promise.all(profileOwnerIds.map(async (ownerId) => {
    const teamLeadId = await findTeamLeadIdForMember(ownerId);
    if (teamLeadId) recipients.add(teamLeadId);
  }));

  if (actor.UserType === 'User' && !profileOwnerIds.includes(actorId)) {
    const actorTeamLeadId = await findTeamLeadIdForMember(actorId);
    if (actorTeamLeadId) recipients.add(actorTeamLeadId);
  }

  const adminIds = await resolveRelevantAdminIds(requirement);
  let effectiveAdminIds = adminIds;
  if (!effectiveAdminIds.length && (actor.UserType === 'User' || actor.UserType === 'TeamLead')) {
    const fallbackAdmins = await NewUser.find({
      UserType: 'Admin',
      ...activeUserFilter,
    })
      .select('_id')
      .lean();
    effectiveAdminIds = fallbackAdmins.map((user) => normalizeId(user._id));
  }
  effectiveAdminIds.forEach((id) => recipients.add(id));

  recipients.delete(actorId);
  return [...recipients];
}

function buildCandidateDisplayName(candidate) {
  const name = `${candidate?.firstName || ''} ${candidate?.lastName || ''}`.trim();
  return name || 'Candidate';
}

function truncateMessage(text, max = 160) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function buildProfileDeepLinkPath(userType, requirementId, profileId) {
  const reqId = normalizeId(requirementId);
  const pid = normalizeId(profileId);
  if (!reqId || !pid) return '';

  let basePath = '/home';
  if (userType === 'Admin') basePath = '/Requirments';
  if (userType === 'TeamLead') basePath = '/TLHome';

  const params = new URLSearchParams();
  params.set('requirementId', reqId);
  params.set('profileId', pid);
  if (userType !== 'Admin' && userType !== 'TeamLead') {
    params.set('tab', 'claimed');
  }
  return `${basePath}?${params.toString()}`;
}

function formatNotificationForApi(doc) {
  return {
    id: doc._id.toString(),
    type: doc.type || 'status_remark',
    title: doc.title,
    message: doc.message,
    link: doc.link || '',
    candidateId: normalizeId(doc.candidateId),
    requirementId: normalizeId(doc.requirementId),
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    unread: !doc.read,
    persisted: true,
  };
}

/** Local calendar day bounds (same midnight/end-of-day pattern as report date filters). */
function getLocalDayBounds(referenceDate = new Date()) {
  const start = new Date(referenceDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(referenceDate);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function buildUnreadPersistedFilter(userId, { todayOnly = true } = {}) {
  const uid = normalizeId(userId);
  const filter = { recipientUserId: uid, read: false };
  if (todayOnly) {
    const { start, end } = getLocalDayBounds();
    filter.createdAt = { $gte: start, $lte: end };
  }
  return filter;
}

async function countUnreadPersistedNotifications(userId, options = {}) {
  const uid = normalizeId(userId);
  if (!uid) return 0;
  const todayOnly = options.todayOnly !== false;
  return NotificationModel.countDocuments(buildUnreadPersistedFilter(uid, { todayOnly }));
}

async function markNotificationAsRead(notificationId, userId) {
  const uid = normalizeId(userId);
  const nid = normalizeId(notificationId);
  if (!uid || !nid) {
    return { ok: false, statusCode: 400, message: 'Invalid notification or user.' };
  }

  const updated = await NotificationModel.findOneAndUpdate(
    { _id: nid, recipientUserId: uid, read: false },
    { $set: { read: true } },
    { new: true },
  ).lean();

  if (!updated) {
    const exists = await NotificationModel.findOne({ _id: nid, recipientUserId: uid }).lean();
    if (exists) {
      return { ok: true, alreadyRead: true, notification: exists };
    }
    return { ok: false, statusCode: 404, message: 'Notification not found.' };
  }

  return { ok: true, alreadyRead: false, notification: updated };
}

async function markAllNotificationsAsRead(userId) {
  const uid = normalizeId(userId);
  if (!uid) return { ok: false, modifiedCount: 0 };

  const result = await NotificationModel.updateMany(
    buildUnreadPersistedFilter(uid, { todayOnly: true }),
    { $set: { read: true } },
  );

  return { ok: true, modifiedCount: result.modifiedCount || 0 };
}

async function createStatusRemarkNotifications({
  actorId,
  candidate,
  mainDocument,
  requirementId,
  status,
  remark,
  statusEntryId,
}) {
  const trimmedRemark = String(remark || '').trim();
  if (!trimmedRemark || !statusEntryId) return { created: 0 };

  const actor = await NewUser.findById(actorId);
  if (!actor || !isActiveUser(actor)) return { created: 0 };

  let requirement = null;
  const reqId = normalizeId(requirementId || mainDocument?.reqId);
  if (reqId) {
    requirement = await NewRequirment.findById(reqId).lean();
    if (requirement) {
      requirement = await enrichRequirementWithClientName(requirement);
    }
  }

  const recipientIds = await resolveStatusRemarkRecipients(
    actor,
    requirement || {},
    candidate,
    mainDocument,
  );

  if (!recipientIds.length) return { created: 0 };

  const activeRecipients = await NewUser.find({
    _id: { $in: recipientIds },
    ...activeUserFilter,
  })
    .select('_id UserType')
    .lean();

  const candidateId = normalizeId(candidate?._id);
  const candidateName = buildCandidateDisplayName(candidate);
  const roleLabel = candidate?.role || requirement?.role || '—';
  const clientLabel = requirement?.client || '—';
  const actorName = actor.EmployeeName || 'Someone';
  const sourceEventId = `${candidateId}:${normalizeId(statusEntryId)}`;

  const title = `Profile status updated — ${candidateName}`;
  const message = truncateMessage(
    `${actorName} set ${candidateName} (${clientLabel} · ${roleLabel}) to ${status}. Remark: ${trimmedRemark}`,
  );

  let created = 0;
  await Promise.all(activeRecipients.map(async (recipient) => {
    const recipientUserId = normalizeId(recipient._id);
    if (!recipientUserId || recipientUserId === normalizeId(actorId)) return;

    try {
      const link = buildProfileDeepLinkPath(recipient.UserType, reqId, candidateId);
      await NotificationModel.create({
        recipientUserId,
        type: 'status_remark',
        title,
        message,
        link,
        candidateId,
        requirementId: reqId,
        actorUserId: normalizeId(actorId),
        sourceEventId,
        read: false,
      });
      created += 1;
    } catch (error) {
      if (error?.code !== 11000) {
        logger.warn('Failed to create status remark notification', {
          recipientUserId,
          sourceEventId,
          error: error.message,
        });
      }
    }
  }));

  return { created };
}

async function listPersistedNotificationsForUser(userId, limit = 10) {
  const uid = normalizeId(userId);
  if (!uid) return [];

  const docs = await NotificationModel.find({ recipientUserId: uid })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return docs.map(formatNotificationForApi);
}

module.exports = {
  createStatusRemarkNotifications,
  listPersistedNotificationsForUser,
  countUnreadPersistedNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  resolveStatusRemarkRecipients,
  resolveProfileOwnerUserIds,
  findTeamLeadIdForMember,
  resolveRelevantAdminIds,
};
