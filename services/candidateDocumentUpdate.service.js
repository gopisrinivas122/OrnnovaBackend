const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CandidateModel = require('../models/Candidate');
const NewUser = require('../models/User');
const { uploadDir } = require('../config/multer');
const { JWT_SECRET } = require('../config/env');
const { ACTIVE_STATUS, isSupportedUserType } = require('../utils/constants');
const { candidateOwnedByUser } = require('../utils/candidateOwnership.util');
const { authorizeTeamLeadProfileView } = require('../utils/teamLeadProfileAccess');
const { stampUploadedPdfTitle } = require('../utils/pdfTitle');

const DOCUMENT_PREVIEW_PURPOSE = 'candidate-document-preview';
const DOCUMENT_PREVIEW_TTL_MS = 2 * 60 * 1000;
const DOCUMENT_PREVIEW_PATH = /^\/api\/candidates\/([^/]+)\/documents\/(updatedResume|ornnovaProfile)(?:\/[^/]+)?$/;

const ALLOWED_DOCUMENT_FIELDS = new Set(['updatedResume', 'ornnovaProfile']);
const ORIGINAL_NAME_FIELDS = {
  updatedResume: 'updatedResumeOriginalName',
  ornnovaProfile: 'ornnovaProfileOriginalName',
};
const ALLOWED_ORIGINAL_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

function sanitizeUploadedPdfFilename(originalName) {
  const raw = String(originalName || '').replace(/[\u0000-\u001f\u007f]/g, '');
  const base = path.win32.basename(path.posix.basename(raw.replace(/\\/g, '/')));
  const cleaned = base
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!cleaned) return '';

  const extension = path.extname(cleaned).toLowerCase();
  const safeExtension = ALLOWED_ORIGINAL_EXTENSIONS.has(extension) ? extension : '.pdf';
  const stemSource = extension ? cleaned.slice(0, -extension.length) : cleaned;
  const stem = stemSource.replace(/[. ]+$/g, '').trim().slice(0, 180);
  if (!stem) return '';
  return `${stem}${safeExtension}`;
}

function rememberUploadedOriginalFilename(target, fieldName, file) {
  const key = ORIGINAL_NAME_FIELDS[fieldName];
  if (!key || !target || !file) return '';
  const originalName = sanitizeUploadedPdfFilename(file.originalname);
  target[key] = originalName || '';
  return target[key];
}

function stampNewUploadTitle(file) {
  if (!file?.path || path.extname(file.path).toLowerCase() !== '.pdf') return false;
  const title = sanitizeUploadedPdfFilename(file.originalname);
  if (!title || path.extname(title).toLowerCase() !== '.pdf') return false;
  return stampUploadedPdfTitle(file.path, title);
}

function contentDispositionInline(downloadName) {
  const name = String(downloadName || 'document.pdf').replace(/[\r\n"]/g, '');
  const asciiName = name.replace(/[^\x20-\x7E]/g, '_');
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function signDocumentPreviewTicket({ userId, candidateId, documentField }) {
  const payload = {
    purpose: DOCUMENT_PREVIEW_PURPOSE,
    userId: String(userId),
    candidateId: String(candidateId),
    documentField,
    exp: Date.now() + DOCUMENT_PREVIEW_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyDocumentPreviewTicket(token) {
  if (!token || typeof token !== 'string') return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }

  if (!payload || payload.purpose !== DOCUMENT_PREVIEW_PURPOSE) return null;
  if (!payload.userId || !payload.candidateId || !ALLOWED_DOCUMENT_FIELDS.has(payload.documentField)) {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

function buildDocumentPreviewPath(candidateId, documentField, userId, downloadName) {
  const ticket = signDocumentPreviewTicket({ userId, candidateId, documentField });
  const safeName = encodeURIComponent(downloadName || `${documentField}.pdf`);
  return `/api/candidates/${encodeURIComponent(candidateId)}/documents/${encodeURIComponent(documentField)}/${safeName}?ticket=${encodeURIComponent(ticket)}`;
}

async function authenticateDocumentPreviewTicket(req) {
  if (!req || req.method !== 'GET') return null;
  const match = DOCUMENT_PREVIEW_PATH.exec(req.path || '');
  const ticket = req.query?.ticket;
  if (!match || !ticket) return null;

  const payload = verifyDocumentPreviewTicket(ticket);
  if (!payload) return null;
  if (payload.candidateId !== match[1] || payload.documentField !== match[2]) return null;

  const user = await NewUser.findById(payload.userId)
    .select('_id Email UserType Status EmployeeName')
    .lean();
  if (!user || user.Status !== ACTIVE_STATUS || !isSupportedUserType(user.UserType)) return null;

  return {
    id: String(user._id),
    email: user.Email,
    role: user.UserType,
    name: user.EmployeeName || '',
  };
}

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

async function canUserAccessCandidateDocuments(actorId, actorRole, context) {
  if (!actorId || !context?.candidate) return false;
  if (actorRole === 'Admin' || actorRole === 'HR') return true;

  const user = await NewUser.findById(actorId).exec();
  if (!user) return false;

  if (actorRole === 'User') {
    return candidateOwnedByUser(context.candidate, context.docRecruiterIds, actorId);
  }

  if (actorRole === 'TeamLead') {
    const decision = await authorizeTeamLeadProfileView(user, context);
    return decision.ok;
  }

  return false;
}

function pickDocumentPayload(candidate) {
  if (!candidate) return null;
  const plain = typeof candidate.toObject === 'function' ? candidate.toObject() : candidate;
  return {
    _id: plain._id,
    updatedResume: plain.updatedResume || '',
    updatedResumeOriginalName: plain.updatedResumeOriginalName || '',
    ornnovaProfile: plain.ornnovaProfile || '',
    ornnovaProfileOriginalName: plain.ornnovaProfileOriginalName || '',
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
    rememberUploadedOriginalFilename(candidate, 'updatedResume', files.updatedResume[0]);
    stampNewUploadTitle(files.updatedResume[0]);
    changed = true;
  }

  if (files.ornnovaProfile?.[0]) {
    candidate.ornnovaProfile = toWebUploadPath(files.ornnovaProfile[0].path);
    rememberUploadedOriginalFilename(candidate, 'ornnovaProfile', files.ornnovaProfile[0]);
    stampNewUploadTitle(files.ornnovaProfile[0]);
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

  const storedOriginalName = sanitizeUploadedPdfFilename(
    candidate[ORIGINAL_NAME_FIELDS[fieldName]],
  );

  return {
    absolutePath,
    downloadName: storedOriginalName || path.basename(absolutePath),
  };
}

module.exports = {
  ALLOWED_DOCUMENT_FIELDS,
  sanitizeUploadedPdfFilename,
  rememberUploadedOriginalFilename,
  stampNewUploadTitle,
  contentDispositionInline,
  signDocumentPreviewTicket,
  verifyDocumentPreviewTicket,
  buildDocumentPreviewPath,
  authenticateDocumentPreviewTicket,
  loadCandidateDocumentContext,
  canUserAccessCandidateDocuments,
  updateCandidateDocuments,
  resolveDocumentForDownload,
  unlinkStoredUploadSafely,
  toWebUploadPath,
};
