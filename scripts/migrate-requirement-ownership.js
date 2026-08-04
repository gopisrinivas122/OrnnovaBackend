/**
 * One-time migration helper for production requirement ownership fields.
 * Run manually: node scripts/migrate-requirement-ownership.js
 */
require('dotenv').config();
const connectDB = require('../config/db');
const NewRequirment = require('../models/Requirement');
const CandidateModel = require('../models/Candidate');
const { getCurrentClaim, getClaimStatus } = require('../services/requirementWorkflow.service');

async function migrate() {
  await connectDB();
  const requirements = await NewRequirment.find({});
  let updated = 0;

  for (const requirement of requirements) {
    let changed = false;

    if (!requirement.createdBy && requirement.uploadedBy) {
      requirement.createdBy = requirement.uploadedBy;
      changed = true;
    }

    if (!requirement.currentClaimedBy?.userId && requirement.claimStatus !== 'Assigned') {
      requirement.claimStatus = 'Assigned';
      changed = true;
    }

    const nextStatus = getClaimStatus(requirement);
    if (requirement.claimStatus !== nextStatus) {
      requirement.claimStatus = nextStatus;
      changed = true;
    }

    const docs = await CandidateModel.find({ reqId: requirement._id.toString() }).select('candidates').lean();
    const total = docs.reduce((sum, doc) => sum + (doc.candidates?.length || 0), 0);
    if (requirement.candidateCount !== total) {
      requirement.candidateCount = total;
      changed = true;
    }

    if (changed) {
      await requirement.save();
      updated += 1;
    }
  }

  console.log(`Migration complete. Updated ${updated} of ${requirements.length} requirements.`);
  process.exit(0);
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
