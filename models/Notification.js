const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipientUserId: { type: String, required: true, index: true },
  type: { type: String, required: true, default: 'status_remark' },
  title: { type: String, required: true },
  message: { type: String, default: '' },
  link: { type: String, default: '' },
  candidateId: { type: String, default: '' },
  requirementId: { type: String, default: '' },
  actorUserId: { type: String, default: '' },
  sourceEventId: { type: String, required: true },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

notificationSchema.index({ recipientUserId: 1, createdAt: -1 });
notificationSchema.index({ sourceEventId: 1, recipientUserId: 1 }, { unique: true });

const NotificationModel = mongoose.model('Notification', notificationSchema);

module.exports = NotificationModel;
