const multer = require('multer');
const path = require('path');
const { UPLOAD_DIR } = require('./env');

const uploadDir = UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

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

module.exports = { upload, uploadFields, uploadDir };
