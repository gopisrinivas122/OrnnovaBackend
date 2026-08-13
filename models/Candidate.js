const mongoose = require('mongoose');

const AssessmentSchema = new mongoose.Schema({
  assessment: { type: String, required: true },
  yoe: { type: String, required: true },
  score: { type: String },
});

const CandidateSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  dob: { type: Date },
  mobileNumber: { type: String, required: true },
  email: { type: String, required: true },
  ctc: { type: String, required: true },
  ectc: { type: String, required: true },
  totalYoe: { type: String, required: true },
  relevantYoe: { type: String, required: true },
  lwd: { type: String },
  currentLocation: { type: String, required: true },
  prefLocation: { type: String, required: true },
  resignationServed: { type: String, enum: ['Yes', 'No'], required: true },
  currentOrg: { type: String, required: true },
  candidateSkills: { type: String, required: true },
  role: { type: String, required: true },
  Status: [
    {
      Status: { type: String, required: true },
      Date: { type: Date, default: Date.now },
      Remark: { type: String, default: '' },
    },
  ],
  savedStatus: { type: String, enum: ['Saved', 'Uploaded'] },
  feedback: { type: String },
  details: { type: String },
  interviewDate: { type: String },
  interviewTime: { type: String, default: '' },
  educationalQualification: { type: String, required: true },
  offerInHand: { type: String },
  remark: { type: String },
  updatedResume: { type: String },
  ornnovaProfile: { type: String },
  candidateImage: { type: String },
  assessments: [AssessmentSchema],
  uploadedOn: { type: Date, default: Date.now },
  recruiterId: [{ type: String, required: true }],
  recruiterName: { type: String },
  rejectionStage: { type: String },
  rejectedDate: { type: Date },
  rejectedBy: { type: String },
  rejectedByName: { type: String },
  rejectionReason: { type: String },
});

const MainSchema = new mongoose.Schema({
  reqId: { type: String, required: true },
  recruiterId: [{ type: String, required: true }],
  candidates: [CandidateSchema],
});

MainSchema.index({ reqId: 1 });
MainSchema.index({ recruiterId: 1 });
MainSchema.index({ reqId: 1, recruiterId: 1 });

const CandidateModel = mongoose.model('Candidate', MainSchema);

module.exports = CandidateModel;
