const NewClient = require('../models/Client');
const {
  mapRowToSchema,
  toStringValue,
  toNumberValue,
  parseListValue,
  buildImportResponse,
  validateRequiredColumns,
} = require('../utils/importHelpers');

const CLIENT_ALIASES = {
  ClientCode: ['client code', 'clientcode', 'code'],
  ClientName: ['client name', 'clientname', 'client'],
  Services: ['services', 'type of service', 'service'],
  Location: ['location'],
  Name: ['name', 'spoc name', 'primary name'],
  Spoc: ['spoc', 'spoc name'],
  MobileNumber: ['mobile number', 'mobile', 'spoc mobile', 'phone'],
  Email: ['email', 'spoc email'],
  Name1: ['name1', 'spoc1 name'],
  Spoc1: ['spoc1'],
  MobileNumber1: ['mobile number1', 'mobile1', 'spoc1 mobile'],
  Email1: ['email1', 'spoc1 email'],
  Name2: ['name2', 'spoc2 name'],
  Spoc2: ['spoc2'],
  MobileNumber2: ['mobile number2', 'mobile2', 'spoc2 mobile'],
  Email2: ['email2', 'spoc2 email'],
  Assign: ['assign', 'assigned users', 'assign users'],
};

const REQUIRED_KEYS = ['ClientCode', 'ClientName'];

function mapClientRow(row) {
  const mapped = mapRowToSchema(row, CLIENT_ALIASES);
  return {
    ClientCode: toStringValue(mapped.ClientCode),
    ClientName: toStringValue(mapped.ClientName),
    Services: toStringValue(mapped.Services) || 'IT Staffing',
    Location: toStringValue(mapped.Location) || '—',
    Name: toStringValue(mapped.Name),
    Spoc: toStringValue(mapped.Spoc) || toStringValue(mapped.Name),
    MobileNumber: toNumberValue(mapped.MobileNumber),
    Email: toStringValue(mapped.Email),
    Name1: toStringValue(mapped.Name1),
    Spoc1: toStringValue(mapped.Spoc1),
    MobileNumber1: toNumberValue(mapped.MobileNumber1),
    Email1: toStringValue(mapped.Email1),
    Name2: toStringValue(mapped.Name2),
    Spoc2: toStringValue(mapped.Spoc2),
    MobileNumber2: toNumberValue(mapped.MobileNumber2),
    Email2: toStringValue(mapped.Email2),
    Assign: parseListValue(mapped.Assign),
  };
}

async function importClients(rows = []) {
  const errors = [];
  let imported = 0;

  if (!Array.isArray(rows) || !rows.length) {
    return buildImportResponse(0, [{ row: 0, reason: 'No rows found in worksheet.' }]);
  }

  const columnCheck = validateRequiredColumns(rows, REQUIRED_KEYS, CLIENT_ALIASES);
  if (!columnCheck.ok) {
    return buildImportResponse(0, [{ row: 1, reason: columnCheck.reason }]);
  }

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 2;
    const payload = mapClientRow(rows[index]);

    try {
      if (!payload.ClientCode) {
        throw new Error('ClientCode is required');
      }
      if (!payload.ClientName) {
        throw new Error('ClientName is required');
      }

      const existing = await NewClient.findOne({ ClientCode: payload.ClientCode });
      if (existing) {
        throw new Error('Duplicate ClientCode');
      }

      const client = new NewClient(payload);
      await client.save();
      imported += 1;
    } catch (error) {
      errors.push({ row: rowNumber, reason: error.message || 'Import failed' });
    }
  }

  return buildImportResponse(imported, errors);
}

module.exports = { importClients, mapClientRow, CLIENT_ALIASES };
