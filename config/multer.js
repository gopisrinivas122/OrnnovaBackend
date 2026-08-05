const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { UPLOAD_DIR } = require('./env');

const uploadDir = UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const jdUploadDir = path.join(uploadDir, 'jd');

const ensureJdUploadDir = () => {
  fs.mkdirSync(jdUploadDir, { recursive: true });
};

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    const uniqueName = `${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  fileFilter(req, file, cb) {
    const allowedFileTypes = /jpeg|jpg|png|pdf/;
    const mimetype = allowedFileTypes.test(file.mimetype);
    const extname = allowedFileTypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Invalid file type. Only JPEG, JPG, PNG, and PDF are allowed.'));
  },
});

const uploadFields = upload.fields([
  { name: 'updatedResume', maxCount: 1 },
  { name: 'ornnovaProfile', maxCount: 1 },
  { name: 'candidateImage', maxCount: 1 },
]);

const jdStorage = multer.diskStorage({
  destination(req, file, cb) {
    ensureJdUploadDir();
    cb(null, jdUploadDir);
  },
  filename(req, file, cb) {
    const uniqueName = `jd-${Date.now()}${path.extname(file.originalname).toLowerCase()}`;
    cb(null, uniqueName);
  },
});

const jdPdfUpload = multer({
  storage: jdStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const isPdf = file.mimetype === 'application/pdf'
      && path.extname(file.originalname).toLowerCase() === '.pdf';

    if (isPdf) {
      return cb(null, true);
    }
    cb(new Error('JD must be a PDF file (maximum 5 MB).'));
  },
});

module.exports = {
  upload,
  uploadFields,
  jdPdfUpload,
  uploadDir,
  jdUploadDir,
};
