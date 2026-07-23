const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { UPLOAD_DIR } = require('./env');

const excelDir = path.join(UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), 'imports');

if (!fs.existsSync(excelDir)) {
  fs.mkdirSync(excelDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, excelDir);
  },
  filename(req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const ALLOWED_EXTENSIONS = /\.(xlsx|xls|csv)$/i;
const ALLOWED_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'text/plain',
  'application/octet-stream',
]);

const excelUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const extOk = ALLOWED_EXTENSIONS.test(ext);
    const mimeOk = ALLOWED_MIMETYPES.has(file.mimetype);

    if (extOk && (mimeOk || ext === '.csv')) {
      return cb(null, true);
    }

    cb(new Error('Unsupported file type. Only .xlsx, .xls, and .csv files are allowed.'));
  },
});

module.exports = { excelUpload, excelDir };
