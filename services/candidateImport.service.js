const NewRequirment = require('../models/Requirement');
const NewUser = require('../models/User');
const CandidateModel = require('../models/Candidate');
const { isValidObjectId } = require('../middleware/validateObjectId');
const { normalizeEmail, normalizeMobile } = require('./candidateDuplicate.service');
const {
  mapRowToSchema,
  toStringValue,
  parseImportDate,
  buildImportResponse,
  validateRequiredColumns,
} = require('../utils/importHelpers');

const CANDIDATE_ALIASES = {
  reqId: ['req id', 'reqid', 'requirement id', 'reg id', 'regid'],
  recruiterId: ['recruiter id', 'recruiterid'],
  firstName: ['first name', 'firstname'],
  lastName: ['last name', 'lastname'],
  dob: ['dob', 'date of birth'],
  mobileNumber: ['mobile number', 'mobile', 'phone'],
  email: ['email', 'email id'],
  ctc: ['ctc', 'current ctc'],
  ectc: ['ectc', 'expected ctc'],
  totalYoe: ['total yoe', 'totalyoe', 'total experience'],
  relevantYoe: ['relevant yoe', 'relevantyoe', 'relevant experience'],
  lwd: ['lwd', 'last working day'],
  currentLocation: ['current location', 'currentlocation'],
  prefLocation: ['pref location', 'preflocation', 'preferred location'],
  resignationServed: ['resignation served', 'resignationserved'],
  currentOrg: ['current org', 'currentorg', 'current organization'],
  candidateSkills: ['candidate skills', 'candidateskills', 'skills'],
  role: ['role'],
  educationalQualification: ['educational qualification', 'educationalqualification', 'qualification'],
  offerInHand: ['offer in hand', 'offerinhand'],
  remark: ['remark', 'remarks'],
  recruiterName: ['recruiter name', 'recruitername'],
  recruiterEmail: ['recruiter email', 'recruiteremail'],
};

const REQUIRED_KEYS = [
  'reqId',
  'firstName',
  'lastName',
  'mobileNumber',
  'email',
  'role',
];

async function resolveRequirementId(value) {
  const raw = toStringValue(value);
  if (!raw) return null;

  if (isValidObjectId(raw)) {
    const byId = await NewRequirment.findById(raw).select('_id').lean();
    if (byId) return byId._id.toString();
  }

  const byRegId = await NewRequirment.findOne({ regId: raw }).select('_id').lean();
  return byRegId?._id?.toString() || null;
}

async function resolveRecruiterId(rowValues = {}) {
  const directId = toStringValue(rowValues.recruiterId);
  if (directId) {
    if (isValidObjectId(directId)) return directId;

    const byEmpCode = await NewUser.findOne({ EmpCode: directId }).select('_id').lean();
    if (byEmpCode) return byEmpCode._id.toString();
  }

  const recruiterEmail = toStringValue(rowValues.recruiterEmail).toLowerCase();
  if (recruiterEmail) {
    const byEmail = await NewUser.findOne({ Email: recruiterEmail }).select('_id').lean();
    if (byEmail) return byEmail._id.toString();
  }

  const recruiterName = toStringValue(rowValues.recruiterName);
  if (recruiterName) {
    const byName = await NewUser.findOne({
      EmployeeName: new RegExp(`^${recruiterName.trim()}$`, 'i'),
    }).select('_id').lean();
    if (byName) return byName._id.toString();
  }

  return null;
}

async function isDuplicateCandidateForRequirement(reqId, email, mobileNumber) {
  const docs = await CandidateModel.find({ reqId }).lean();

  for (const doc of docs) {
    for (const candidate of doc.candidates || []) {
      if (
        normalizeEmail(candidate.email) === normalizeEmail(email)
        && normalizeMobile(candidate.mobileNumber) === normalizeMobile(mobileNumber)
      ) {
        return true;
      }
    }
  }

  return false;
}

function mapCandidateRow(row) {
  const mapped = mapRowToSchema(row, CANDIDATE_ALIASES);
  const dob = parseImportDate(mapped.dob);
  const lwdDate = parseImportDate(mapped.lwd);
  const resignationServed = toStringValue(mapped.resignationServed) || 'No';

  return {
    reqId: toStringValue(mapped.reqId),
    recruiterId: toStringValue(mapped.recruiterId),
    recruiterEmail: toStringValue(mapped.recruiterEmail),
    recruiterName: toStringValue(mapped.recruiterName),
    firstName: toStringValue(mapped.firstName),
    lastName: toStringValue(mapped.lastName),
    dob,
    mobileNumber: toStringValue(mapped.mobileNumber),
    email: toStringValue(mapped.email).toLowerCase(),
    ctc: toStringValue(mapped.ctc) || '—',
    ectc: toStringValue(mapped.ectc) || '—',
    totalYoe: toStringValue(mapped.totalYoe) || '—',
    relevantYoe: toStringValue(mapped.relevantYoe) || '—',
    lwd: lwdDate ? lwdDate.toISOString() : toStringValue(mapped.lwd) || '0000-00-00T00:00:00.000Z',
    currentLocation: toStringValue(mapped.currentLocation) || '—',
    prefLocation: toStringValue(mapped.prefLocation) || '—',
    resignationServed: ['Yes', 'No'].includes(resignationServed) ? resignationServed : 'No',
    currentOrg: toStringValue(mapped.currentOrg) || '—',
    candidateSkills: toStringValue(mapped.candidateSkills) || '—',
    role: toStringValue(mapped.role),
    educationalQualification: toStringValue(mapped.educationalQualification) || '—',
    offerInHand: toStringValue(mapped.offerInHand),
    remark: toStringValue(mapped.remark),
  };
}

async function importCandidates(rows = []) {
  const errors = [];
  let imported = 0;

  if (!Array.isArray(rows) || !rows.length) {
    return buildImportResponse(0, [{ row: 0, reason: 'No rows found in worksheet.' }]);
  }

  const columnCheck = validateRequiredColumns(rows, REQUIRED_KEYS, CANDIDATE_ALIASES);
  if (!columnCheck.ok) {
    return buildImportResponse(0, [{ row: 1, reason: columnCheck.reason }]);
  }

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 2;
    const payload = mapCandidateRow(rows[index]);

    try {
      if (!payload.reqId) throw new Error('reqId is required');
      if (!payload.firstName) throw new Error('firstName is required');
      if (!payload.lastName) throw new Error('lastName is required');
      if (!payload.mobileNumber) throw new Error('mobileNumber is required');
      if (!payload.email) throw new Error('email is required');
      if (!payload.role) throw new Error('role is required');
      if (!payload.dob) throw new Error('Invalid or missing dob');

      const resolvedReqId = await resolveRequirementId(payload.reqId);
      if (!resolvedReqId) {
        throw new Error(`Requirement not found for reqId/regId: ${payload.reqId}`);
      }

      const resolvedRecruiterId = await resolveRecruiterId(payload);
      if (!resolvedRecruiterId) {
        throw new Error('recruiterId is required (or provide recruiterEmail / recruiterName)');
      }

      const duplicate = await isDuplicateCandidateForRequirement(
        resolvedReqId,
        payload.email,
        payload.mobileNumber
      );
      if (duplicate) {
        throw new Error('Duplicate Email + Mobile Number for the same Requirement');
      }

      const recruiter = await NewUser.findById(resolvedRecruiterId).select('EmployeeName').lean();
      const recruiterName = payload.recruiterName || recruiter?.EmployeeName || '';

      const candidateData = {
        date: new Date(),
        firstName: payload.firstName,
        lastName: payload.lastName,
        dob: payload.dob,
        mobileNumber: payload.mobileNumber,
        email: payload.email,
        ctc: payload.ctc,
        ectc: payload.ectc,
        totalYoe: payload.totalYoe,
        relevantYoe: payload.relevantYoe,
        lwd: payload.lwd,
        currentLocation: payload.currentLocation,
        prefLocation: payload.prefLocation,
        resignationServed: payload.resignationServed,
        currentOrg: payload.currentOrg,
        candidateSkills: payload.candidateSkills,
        role: payload.role,
        educationalQualification: payload.educationalQualification,
        offerInHand: payload.offerInHand,
        remark: payload.remark,
        savedStatus: 'Uploaded',
        Status: [],
        recruiterId: [resolvedRecruiterId],
        recruiterName,
        uploadedOn: new Date(),
      };

      let existingCandidate = await CandidateModel.findOne({
        reqId: resolvedReqId,
        recruiterId: resolvedRecruiterId,
      });

      if (existingCandidate) {
        existingCandidate.candidates.push(candidateData);
        await existingCandidate.save();
      } else {
        existingCandidate = new CandidateModel({
          reqId: resolvedReqId,
          recruiterId: [resolvedRecruiterId],
          candidates: [candidateData],
        });
        await existingCandidate.save();
      }

      imported += 1;
    } catch (error) {
      errors.push({ row: rowNumber, reason: error.message || 'Import failed' });
    }
  }

  return buildImportResponse(imported, errors);
}

module.exports = { importCandidates, mapCandidateRow, CANDIDATE_ALIASES };
