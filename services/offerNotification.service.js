const NotificationModel = require('../models/Notification');

function buildOfferSourceEventId(offerId, historyId) {
  return `offer:${offerId}:${historyId}`;
}

async function createOfferWorkflowNotification(payload, model = NotificationModel) {
  try {
    await model.create({
      recipientUserId: payload.recipientUserId,
      type: 'offer_workflow',
      title: payload.title,
      message: payload.message || '',
      link: payload.link || '',
      candidateId: payload.candidateId || '',
      requirementId: payload.requirementId || '',
      actorUserId: payload.actorUserId || '',
      sourceEventId: payload.sourceEventId,
      read: false,
    });
    return { created: true, duplicate: false };
  } catch (error) {
    if (error && error.code === 11000) {
      return { created: false, duplicate: true };
    }
    throw error;
  }
}

module.exports = {
  buildOfferSourceEventId,
  createOfferWorkflowNotification,
};
