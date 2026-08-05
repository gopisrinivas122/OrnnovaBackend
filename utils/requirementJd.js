const path = require('path');
const fs = require('fs');
const { uploadDir } = require('../config/multer');

function buildJdPublicPath(file) {
  if (!file?.filename) return '';
  return path.posix.join('/uploads/jd', file.filename);
}

function resolveJdAbsolutePath(jdPdf = '') {
  if (!jdPdf) return '';
  const relativePath = jdPdf.replace(/^\/uploads\/?/, '');
  return path.join(uploadDir, relativePath);
}

function deleteJdFileIfExists(jdPdf = '') {
  const absolutePath = resolveJdAbsolutePath(jdPdf);
  if (!absolutePath || !fs.existsSync(absolutePath)) return;
  fs.unlinkSync(absolutePath);
}

module.exports = {
  buildJdPublicPath,
  resolveJdAbsolutePath,
  deleteJdFileIfExists,
};
