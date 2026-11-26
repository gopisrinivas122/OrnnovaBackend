const mongoose = require('mongoose');

const offerApprovalHistorySchema = new mongoose.Schema({
  offerRequestId: { type: String, required: true },
  action: { type: String, required: true },
  previousStatus: { type: String, default: '' },
  newStatus: { type: String, required: true },
  actorUserId: { type: String, required: true },
  actorRole: { type: String, required: true },
  comments: { type: String, default: '' },
  correlationId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
}, {
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
});

function rejectHistoryMutation(next) {
  next(new Error('Offer approval history is append-only'));
}

offerApprovalHistorySchema.pre('save', function rejectExistingSave(next) {
  if (!this.isNew) {
    next(new Error('Offer approval history is append-only'));
    return;
  }
  next();
});

[
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findOneAndReplace',
].forEach((hook) => {
  offerApprovalHistorySchema.pre(hook, rejectHistoryMutation);
});

offerApprovalHistorySchema.index({ offerRequestId: 1, createdAt: 1 });

const OfferApprovalHistory = mongoose.model(
  'OfferApprovalHistory',
  offerApprovalHistorySchema,
  'offer_approval_histories',
);

module.exports = OfferApprovalHistory;
