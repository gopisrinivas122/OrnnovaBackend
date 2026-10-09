const fs = require('fs');
const path = require('path');
const CandidateModel = require('../models/Candidate');
const NewRequirment = require('../models/Requirement');
const NewUser = require('../models/User');
const { uploadDir } = require('../config/multer');
const { candidateOwnedByUser } = require('../utils/candidateOwnership.util');
const { userCanAccessRequirement } = require('../utils/teamLeadRequirements');
const { isValidObjectId } = require('../middleware/validateObjectId');

const ALLOWED_DOCUMENT_FIELDS = new Set(['updatedResume', 'ornnovaProfile']);

function toWebUploadPath(absolutePath) {
  return path.posix.join('/uploads', path.basename(absolutePath));
}

function resolveAbsolutePathFromStored(storedPath) {
  if (!storedPath || typeof storedPath !== 'string') return null;
  const normalized = storedPath.replace(/\\/g, '/');
  const basename = path.basename(normalized);
  if (!basename) return null;
  return path.join(uploadDir, basename);
}

function unlinkStoredUploadSafely(storedPath) {
  const absolute = resolveAbsolutePathFromStored(storedPath);
  if (!absolute || !fs.existsSync(absolute)) return;
  try {
    fs.unlinkSync(absolute);
  } catch (error) {
    console.warn('Failed to remove upload file:', absolute, error.message);
  }
}

async function loadCandidateDocumentContext(candidateId) {
  const mainDoc = await CandidateModel.findOne({ 'candidates._id': candidateId });
  if (!mainDoc) {
    return { error: { statusCode: 404, message: 'Candidate not found.' } };
  }

  const candidate = mainDoc.candidates.id(candidateId);
  if (!candidate) {
    return { error: { statusCode: 404, message: 'Candidate not found.' } };
  }

  const docRecruiterIds = Array.isArray(mainDoc.recruiterId) ? mainDoc.recruiterId : [];

  return {
    mainDoc,
    candidate,
    reqId: mainDoc.reqId,
    docRecruiterIds,
  };
}

async function findRequirementForReqId(reqId) {
  if (!reqId) return null;
  const raw = String(reqId).trim();
  const orConditions = [{ regId: raw }];
  if (isValidObjectId(raw)) {
    orConditions.push({ _id: raw });
  }
  return NewRequirment.findOne({ $or: orConditions }).exec();
}

async function canUserAccessCandidateDocuments(actorId, actorRole, context) {
  if (!actorId || !context?.candidate) return false;
  if (actorRole === 'Admin') return true;

  const user = await NewUser.findById(actorId).exec();
  if (!user) return false;

  if (actorRole === 'User') {
    return candidateOwnedByUser(context.candidate, context.docRecruiterIds, actorId);
  }

  if (actorRole === 'TeamLead') {
    const requirement = await findRequirementForReqId(context.reqId);
    return userCanAccessRequirement(user, requirement);
  }

  return false;
}

function pickDocumentPayload(candidate) {
  if (!candidate) return null;
  const plain = typeof candidate.toObject === 'function' ? candidate.toObject() : candidate;
  return {
    _id: plain._id,
    updatedResume: plain.updatedResume || '',
    ornnovaProfile: plain.ornnovaProfile || '',
  };
}

async function updateCandidateDocuments(candidateId, files = {}) {
  const context = await loadCandidateDocumentContext(candidateId);
  if (context.error) return { error: context.error };

  const { mainDoc, candidate } = context;
  const previousPaths = {
    updatedResume: candidate.updatedResume,
    ornnovaProfile: candidate.ornnovaProfile,
  };

  let changed = false;

  if (files.updatedResume?.[0]) {
    candidate.updatedResume = toWebUploadPath(files.updatedResume[0].path);
    changed = true;
  }

  if (files.ornnovaProfile?.[0]) {
    candidate.ornnovaProfile = toWebUploadPath(files.ornnovaProfile[0].path);
    changed = true;
  }

  if (!changed) {
    return { error: { statusCode: 400, message: 'No document files were provided.' } };
  }

  try {
    await mainDoc.save();
  } catch (error) {
    if (files.updatedResume?.[0]) {
      unlinkStoredUploadSafely(toWebUploadPath(files.updatedResume[0].path));
    }
    if (files.ornnovaProfile?.[0]) {
      unlinkStoredUploadSafely(toWebUploadPath(files.ornnovaProfile[0].path));
    }
    throw error;
  }

  if (files.updatedResume?.[0] && previousPaths.updatedResume) {
    unlinkStoredUploadSafely(previousPaths.updatedResume);
  }
  if (files.ornnovaProfile?.[0] && previousPaths.ornnovaProfile) {
    unlinkStoredUploadSafely(previousPaths.ornnovaProfile);
  }

  return { candidate: pickDocumentPayload(candidate) };
}

function resolveDocumentForDownload(candidate, fieldName) {
  if (!ALLOWED_DOCUMENT_FIELDS.has(fieldName)) {
    return { error: { statusCode: 400, message: 'Invalid document type.' } };
  }

  const storedPath = candidate[fieldName];
  if (!storedPath || typeof storedPath !== 'string') {
    return { error: { statusCode: 404, message: 'Document file not found for this profile.' } };
  }

  const absolutePath = resolveAbsolutePathFromStored(storedPath);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return { error: { statusCode: 404, message: 'Document file is missing on the server.' } };
  }

  return { absolutePath, downloadName: path.basename(absolutePath) };
}

module.exports = {
  ALLOWED_DOCUMENT_FIELDS,
  loadCandidateDocumentContext,
  canUserAccessCandidateDocuments,
  updateCandidateDocuments,
  resolveDocumentForDownload,
  unlinkStoredUploadSafely,
  toWebUploadPath,
};
