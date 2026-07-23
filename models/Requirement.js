const mongoose = require('mongoose');

const RequirementSchema = new mongoose.Schema({
  regId: { type: String, required: true },
  client: { type: String, required: true },
  typeOfContract: { type: String, required: true },
  startDate: { type: Date, required: true },
  duration: { type: String, required: true },
  location: { type: String, required: true },
  sourceCtc: { type: String, required: true },
  qualification: { type: String, required: true },
  yearsExperience: { type: String, required: true },
  relevantExperience: { type: String, required: true },
  skill: { type: String, required: true },
  role: { type: String },
  requirementtype: { type: String, required: true },
  numberOfPositions: { type: Number, default: 1 },
  workMode: { type: String, enum: ['Onsite', 'Hybrid', 'Remote', ''], default: '' },
  hiringManager: { type: String, default: '' },
  noticePeriodDays: { type: String, default: '' },
  expectedOnboardDate: { type: Date },
  interviewProcess: { type: String, default: '' },
  remarks: { type: String, default: '' },
  assessments: [
    {
      assessment: { type: String, required: true },
      yoe: { type: String, required: true },
    },
  ],
  uploadedBy: { type: String },
  clientId: { type: String },
  update: { type: String, default: 'New' },
  uploadedDate: { type: Date, default: Date.now },
  claimedBy: [{ userId: String, claimedDate: Date }],
});

RequirementSchema.index({ clientId: 1 });
RequirementSchema.index({ regId: 1 });

const NewRequirment = mongoose.model('Requirements', RequirementSchema);

module.exports = NewRequirment;
