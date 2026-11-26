const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const PRIVATE_OFFER_DIR = path.join(__dirname, '..', 'private-offer-documents');
const MAX_OFFER_DOCUMENT_BYTES = 5 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Map([
  ['.pdf', new Set(['application/pdf'])],
  ['.jpg', new Set(['image/jpeg', 'image/jpg'])],
  ['.jpeg', new Set(['image/jpeg', 'image/jpg'])],
  ['.png', new Set(['image/png'])],
]);

function invalidDocumentError() {
  const error = new Error('Invalid document reference');
  error.statusCode = 400;
  error.code = 'INVALID_DOCUMENT';
  error.isOfferWorkflowError = true;
  return error;
}

function ensurePrivateOfferDir() {
  fs.mkdirSync(PRIVATE_OFFER_DIR, { recursive: true });
}

function sanitizeOriginalFilename(name) {
  const base = path.basename(String(name || 'document'))
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .slice(0, 180)
    .trim();
  return base || 'document';
}

function resolvePrivateDocumentPath(storageKey, baseDir = PRIVATE_OFFER_DIR) {
  const key = String(storageKey || '');
  if (!key || key !== path.basename(key) || !/^[a-zA-Z0-9._-]+$/.test(key)) {
    throw invalidDocumentError();
  }
  const base = path.resolve(baseDir);
  const full = path.resolve(base, key);
  if (full !== path.join(base, key)) {
    throw invalidDocumentError();
  }
  return full;
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  const base = path.resolve(PRIVATE_OFFER_DIR);
  const resolved = path.resolve(filePath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return;
  await fs.promises.unlink(resolved).catch(() => {});
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      ensurePrivateOfferDir();
      cb(null, PRIVATE_OFFER_DIR);
    } catch (error) {
      cb(error);
    }
  },
  filename(req, file, cb) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const key = `offer-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`;
    cb(null, key);
  },
});

function offerFileFilter(req, file, cb) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const allowedMimes = ALLOWED_EXTENSIONS.get(extension);
  if (!allowedMimes || !allowedMimes.has(String(file.mimetype || '').toLowerCase())) {
    cb(new Error('Invalid file type. Only JPEG, JPG, PNG, and PDF are allowed.'));
    return;
  }
  cb(null, true);
}

const offerDocumentUpload = multer({
  storage,
  limits: { fileSize: MAX_OFFER_DOCUMENT_BYTES, files: 1 },
  fileFilter: offerFileFilter,
});

module.exports = {
  PRIVATE_OFFER_DIR,
  MAX_OFFER_DOCUMENT_BYTES,
  ALLOWED_EXTENSIONS,
  sanitizeOriginalFilename,
  resolvePrivateDocumentPath,
  safeUnlink,
  offerDocumentUpload,
};
