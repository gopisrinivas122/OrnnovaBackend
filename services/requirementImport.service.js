const NewRequirment = require('../models/Requirement');
const NewClient = require('../models/Client');
const NewUser = require('../models/User');
const { normalizeRequirementType, isValidRequirementType } = require('../utils/requirementType');
const { attachRequirementToTeamLead, linkRequirementToMatchingTeamLeads } = require('../utils/teamLeadRequirements');
const {
  mapRowToSchema,
  toStringValue,
  toNumberValue,
  parseImportDate,
  buildImportResponse,
  validateRequiredColumns,
} = require('../utils/importHelpers');

const REQUIREMENT_ALIASES = {
  regId: ['reg id', 'regid', 'requirement id'],
  client: ['client', 'client name'],
  typeOfContract: ['type of contract', 'contract type', 'typeofcontract'],
  startDate: ['start date', 'startdate'],
  duration: ['duration'],
  location: ['location'],
  sourceCtc: ['source ctc', 'ctc', 'sourcectc'],
  qualification: ['qualification'],
  yearsExperience: ['years experience', 'yearsexperience', 'yoe'],
  relevantExperience: ['relevant experience', 'relevantexperience'],
  skill: ['skill', 'skills'],
  role: ['role'],
  requirementtype: ['requirement type', 'requirementtype', 'req type'],
  numberOfPositions: ['number of positions', 'numberofpositions', 'positions', 'openings'],
  workMode: ['work mode', 'workmode'],
  hiringManager: ['hiring manager', 'hiringmanager'],
  noticePeriodDays: ['notice period days', 'noticeperioddays'],
  expectedOnboardDate: ['expected onboard date', 'expectedonboarddate'],
  interviewProcess: ['interview process', 'interviewprocess'],
  remarks: ['remarks', 'remark'],
  uploadedBy: ['uploaded by', 'uploadedby'],
  clientId: ['client id', 'clientid'],
};

const REQUIRED_KEYS = ['regId', 'client', 'typeOfContract', 'startDate', 'role'];

async function resolveClientId(clientName, explicitClientId = '') {
  if (explicitClientId) return String(explicitClientId);
  if (!clientName) return '';

  const client = await NewClient.findOne({
    ClientName: new RegExp(`^${clientName.trim()}$`, 'i'),
  }).lean();

  return client?._id ? String(client._id) : '';
}

function mapRequirementRow(row) {
  const mapped = mapRowToSchema(row, REQUIREMENT_ALIASES);
  const startDate = parseImportDate(mapped.startDate);
  const expectedOnboardDate = parseImportDate(mapped.expectedOnboardDate);

  return {
    regId: toStringValue(mapped.regId),
    client: toStringValue(mapped.client),
    typeOfContract: toStringValue(mapped.typeOfContract),
    startDate,
    duration: toStringValue(mapped.duration) || '—',
    location: toStringValue(mapped.location) || '—',
    sourceCtc: toStringValue(mapped.sourceCtc) || '—',
    qualification: toStringValue(mapped.qualification) || '—',
    yearsExperience: toStringValue(mapped.yearsExperience) || '—',
    relevantExperience: toStringValue(mapped.relevantExperience) || '—',
    skill: toStringValue(mapped.skill) || '—',
    role: toStringValue(mapped.role),
    requirementtype: normalizeRequirementType(mapped.requirementtype) || 'High',
    numberOfPositions: toNumberValue(mapped.numberOfPositions, 1),
    workMode: toStringValue(mapped.workMode),
    hiringManager: toStringValue(mapped.hiringManager),
    noticePeriodDays: toStringValue(mapped.noticePeriodDays),
    expectedOnboardDate,
    interviewProcess: toStringValue(mapped.interviewProcess),
    remarks: toStringValue(mapped.remarks),
    uploadedBy: toStringValue(mapped.uploadedBy),
    clientId: toStringValue(mapped.clientId),
  };
}

async function importRequirements(rows = [], options = {}) {
  const errors = [];
  let imported = 0;
  const uploadedBy = options.uploadedBy || '';

  if (!Array.isArray(rows) || !rows.length) {
    return buildImportResponse(0, [{ row: 0, reason: 'No rows found in worksheet.' }]);
  }

  const columnCheck = validateRequiredColumns(rows, REQUIRED_KEYS, REQUIREMENT_ALIASES);
  if (!columnCheck.ok) {
    return buildImportResponse(0, [{ row: 1, reason: columnCheck.reason }]);
  }

  let uploaderType = '';
  if (uploadedBy) {
    const uploader = await NewUser.findById(uploadedBy).select('UserType').lean();
    uploaderType = uploader?.UserType || '';
  }

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 2;
    const payload = mapRequirementRow(rows[index]);

    try {
      if (!payload.regId) throw new Error('regId is required');
      if (!payload.client) throw new Error('client is required');
      if (!payload.typeOfContract) throw new Error('typeOfContract is required');
      if (!payload.role) throw new Error('role is required');
      if (!payload.startDate) throw new Error('Invalid or missing startDate');

      const existing = await NewRequirment.findOne({ regId: payload.regId });
      if (existing) throw new Error('Duplicate regId');

      if (!isValidRequirementType(payload.requirementtype)) {
        throw new Error(`Invalid requirementtype: ${payload.requirementtype}`);
      }

      const clientId = await resolveClientId(payload.client, payload.clientId);
      const effectiveUploadedBy = uploadedBy || payload.uploadedBy;

      const requirement = new NewRequirment({
        regId: payload.regId,
        client: payload.client,
        typeOfContract: payload.typeOfContract,
        startDate: payload.startDate,
        duration: payload.duration,
        location: payload.location,
        sourceCtc: payload.sourceCtc,
        qualification: payload.qualification,
        yearsExperience: payload.yearsExperience,
        relevantExperience: payload.relevantExperience,
        skill: payload.skill,
        role: payload.role,
        requirementtype: payload.requirementtype,
        numberOfPositions: payload.numberOfPositions,
        workMode: payload.workMode,
        hiringManager: payload.hiringManager,
        noticePeriodDays: payload.noticePeriodDays,
        expectedOnboardDate: payload.expectedOnboardDate || undefined,
        interviewProcess: payload.interviewProcess,
        remarks: payload.remarks,
        uploadedBy: effectiveUploadedBy,
        clientId,
        update: 'New',
        assessments: [],
      });

      await requirement.save();

      if (effectiveUploadedBy && uploaderType === 'TeamLead') {
        await attachRequirementToTeamLead(effectiveUploadedBy, requirement._id);
      }
      await linkRequirementToMatchingTeamLeads(requirement);

      imported += 1;
    } catch (error) {
      errors.push({ row: rowNumber, reason: error.message || 'Import failed' });
    }
  }

  return buildImportResponse(imported, errors);
}

module.exports = { importRequirements, mapRequirementRow, REQUIREMENT_ALIASES };
