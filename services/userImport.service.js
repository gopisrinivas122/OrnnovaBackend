const NewUser = require('../models/User');
const {
  mapRowToSchema,
  toStringValue,
  buildImportResponse,
  validateRequiredColumns,
} = require('../utils/importHelpers');

const USER_ALIASES = {
  EmpCode: ['emp code', 'empcode', 'employee code'],
  EmployeeName: ['employee name', 'employeename', 'name'],
  Email: ['email', 'email id'],
  Password: ['password', 'pwd'],
  UserType: ['user type', 'usertype', 'role'],
  Status: ['status'],
  CreatedBy: ['created by', 'createdby', 'initiated by'],
};

const REQUIRED_KEYS = ['EmpCode', 'EmployeeName', 'Email', 'UserType', 'Status'];
const ALLOWED_USER_TYPES = new Set(['Admin', 'TeamLead', 'User']);
const ALLOWED_STATUS = new Set(['Active', 'InActive']);
const DEFAULT_PASSWORD = 'ChangeMe@123';
const DEFAULT_PROFILE_PIC = '/Images/icon.png';

function mapUserRow(row) {
  const mapped = mapRowToSchema(row, USER_ALIASES);
  return {
    EmpCode: toStringValue(mapped.EmpCode),
    EmployeeName: toStringValue(mapped.EmployeeName),
    Email: toStringValue(mapped.Email).toLowerCase(),
    Password: toStringValue(mapped.Password) || DEFAULT_PASSWORD,
    UserType: toStringValue(mapped.UserType),
    Status: toStringValue(mapped.Status) || 'Active',
    CreatedBy: toStringValue(mapped.CreatedBy),
  };
}

async function importUsers(rows = []) {
  const errors = [];
  let imported = 0;

  if (!Array.isArray(rows) || !rows.length) {
    return buildImportResponse(0, [{ row: 0, reason: 'No rows found in worksheet.' }]);
  }

  const columnCheck = validateRequiredColumns(rows, REQUIRED_KEYS, USER_ALIASES);
  if (!columnCheck.ok) {
    return buildImportResponse(0, [{ row: 1, reason: columnCheck.reason }]);
  }

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 2;
    const payload = mapUserRow(rows[index]);

    try {
      if (!payload.EmpCode) throw new Error('EmpCode is required');
      if (!payload.EmployeeName) throw new Error('EmployeeName is required');
      if (!payload.Email) throw new Error('Email is required');
      if (!payload.UserType) throw new Error('UserType is required');
      if (!payload.Status) throw new Error('Status is required');

      if (!ALLOWED_USER_TYPES.has(payload.UserType)) {
        throw new Error(`Invalid UserType: ${payload.UserType}`);
      }

      if (!ALLOWED_STATUS.has(payload.Status)) {
        throw new Error(`Invalid Status: ${payload.Status}`);
      }

      const existing = await NewUser.findOne({
        $or: [{ Email: payload.Email }, { EmpCode: payload.EmpCode }],
      });

      if (existing) {
        if (existing.Email === payload.Email) {
          throw new Error('Duplicate Email');
        }
        throw new Error('Duplicate EmpCode');
      }

      const user = new NewUser({
        EmpCode: payload.EmpCode,
        EmployeeName: payload.EmployeeName,
        Email: payload.Email,
        Password: payload.Password,
        UserType: payload.UserType,
        Status: payload.Status,
        CreatedBy: payload.CreatedBy,
        ProfilePic: DEFAULT_PROFILE_PIC,
        Team: [],
        Clients: [],
        Requirements: [],
      });

      await user.save();
      imported += 1;
    } catch (error) {
      errors.push({ row: rowNumber, reason: error.message || 'Import failed' });
    }
  }

  return buildImportResponse(imported, errors);
}

module.exports = { importUsers, mapUserRow, USER_ALIASES };
