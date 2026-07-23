const asyncHandler = require('../middleware/asyncHandler');
const { excelUpload } = require('../config/excelUpload');
const { parseSpreadsheetFile, deleteUploadedFile } = require('../utils/spreadsheetParser');
const { buildImportResponse } = require('../utils/importHelpers');
const { importClients } = require('../services/clientImport.service');
const { importRequirements } = require('../services/requirementImport.service');
const { importUsers } = require('../services/userImport.service');
const { importCandidates } = require('../services/candidateImport.service');

function createImportHandler(importFn, options = {}) {
  return asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json(
        buildImportResponse(0, [{
          row: 0,
          reason: 'Missing Excel file. Upload using form field name "file".',
        }])
      );
    }

    const filePath = req.file.path;

    try {
      let rows;
      try {
        rows = parseSpreadsheetFile(filePath);
      } catch (error) {
        return res.status(400).json(
          buildImportResponse(0, [{ row: 0, reason: error.message || 'Unable to read file.' }])
        );
      }

      const result = await importFn(rows, {
        uploadedBy: req.body?.uploadedBy || req.query?.uploadedBy || '',
        ...options,
      });

      const statusCode = result.imported > 0 ? 200 : 400;
      return res.status(statusCode).json(result);
    } finally {
      await deleteUploadedFile(filePath);
    }
  });
}

module.exports = (app) => {
  app.post(
    '/importClients',
    excelUpload.single('file'),
    createImportHandler(importClients)
  );

  app.post(
    '/importRequirements',
    excelUpload.single('file'),
    createImportHandler(importRequirements)
  );

  app.post(
    '/importUsers',
    excelUpload.single('file'),
    createImportHandler(importUsers)
  );

  app.post(
    '/importCandidates',
    excelUpload.single('file'),
    createImportHandler(importCandidates)
  );
};
