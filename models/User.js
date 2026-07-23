const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  EmpCode: { type: String, required: true },
  EmployeeName: { required: true, type: String },
  Email: { required: true, type: String },
  Password: { required: true, type: String },
  UserType: { required: true, type: String },
  ProfilePic: { type: String },
  Status: { type: String },
  verifytoken: { type: String },
  token: { type: String },
  CreatedBy: { type: String },
  Team: [{ type: String }],
  Clients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Client' }],
  Requirements: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Requirements' }],
  claimedRequirements: [{ type: mongoose.Schema.Types.ObjectId, ref: 'NewRequirement' }],
});

userSchema.index({ Email: 1 });
userSchema.index({ UserType: 1, Status: 1 });
userSchema.index({ Clients: 1 });
userSchema.index({ Requirements: 1 });

const NewUser = mongoose.model('Users', userSchema);

module.exports = NewUser;
