const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);

function parseSpreadsheetFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Uploaded file not found.');
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error('Unsupported file type. Only .xlsx, .xls, and .csv files are allowed.');
  }

  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    throw new Error('Worksheet is empty.');
  }

  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

async function deleteUploadedFile(filePath) {
  if (!filePath) return;

  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

module.exports = {
  parseSpreadsheetFile,
  deleteUploadedFile,
};
