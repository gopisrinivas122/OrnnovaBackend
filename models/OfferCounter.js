const mongoose = require('mongoose');

const offerCounterSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  seq: { type: Number, required: true, default: 0 },
}, {
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
});

offerCounterSchema.index({ year: 1 }, { unique: true });

const OfferCounter = mongoose.model('OfferCounter', offerCounterSchema, 'offer_counters');

module.exports = OfferCounter;
