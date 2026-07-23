const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
  ClientCode: { required: true, type: String, unique: true },
  ClientName: { required: true, type: String },
  Services: { required: true, type: String },
  Location: { required: true, type: String },
  Name: { type: String },
  Spoc: { type: String },
  MobileNumber: { type: Number },
  Email: { type: String },
  Name1: { type: String },
  Spoc1: { type: String },
  MobileNumber1: { type: Number },
  Email1: { type: String },
  Name2: { type: String },
  Spoc2: { type: String },
  MobileNumber2: { type: Number },
  Email2: { type: String },
  Assign: [{ type: String }],
});

const NewClient = mongoose.model('Clients', clientSchema);

module.exports = NewClient;
