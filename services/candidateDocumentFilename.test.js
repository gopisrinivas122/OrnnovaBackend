const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CandidateModel = require('../models/Candidate');
const { uploadDir } = require('../config/multer');
const {
  sanitizeUploadedPdfFilename,
  rememberUploadedOriginalFilename,
  updateCandidateDocuments,
  resolveDocumentForDownload,
  contentDispositionInline,
  signDocumentPreviewTicket,
  verifyDocumentPreviewTicket,
  buildDocumentPreviewPath,
  authenticateDocumentPreviewTicket,
} = require('./candidateDocumentUpdate.service');
const NewUser = require('../models/User');
const { authMiddleware } = require('../middleware/auth');

function createCandidate(initial) {
  const candidate = { ...initial };
  candidate.toObject = () => {
    const plain = { ...candidate };
    delete plain.toObject;
    return plain;
  };
  return candidate;
}

function uploadedFile(originalname, storedBasename) {
  return {
    originalname,
    path: path.join(uploadDir, storedBasename),
  };
}

(async () => {
  assert.strictEqual(
    sanitizeUploadedPdfFilename('Anjali_Updated_Resume.pdf'),
    'Anjali_Updated_Resume.pdf',
  );
  assert.strictEqual(
    sanitizeUploadedPdfFilename('Anjali_Ornnova_Profile.pdf'),
    'Anjali_Ornnova_Profile.pdf',
  );
  assert.strictEqual(
    sanitizeUploadedPdfFilename('C:\\fakepath\\Anjali_Updated_Resume.PDF'),
    'Anjali_Updated_Resume.pdf',
  );
  assert.strictEqual(
    sanitizeUploadedPdfFilename('../../Anjali_Updated_Resume.pdf'),
    'Anjali_Updated_Resume.pdf',
  );
  assert.strictEqual(sanitizeUploadedPdfFilename('bad"name\r\n.pdf'), 'badname.pdf');
  assert.strictEqual(sanitizeUploadedPdfFilename(''), '');

  const ignoredClientName = { updatedResumeOriginalName: 'client-supplied.pdf' };
  rememberUploadedOriginalFilename(
    ignoredClientName,
    'updatedResume',
    uploadedFile('Anjali_Updated_Resume.pdf', 'unused.pdf'),
  );
  assert.strictEqual(ignoredClientName.updatedResumeOriginalName, 'Anjali_Updated_Resume.pdf');

  const resumeBasename = `filename-preservation-resume-${process.pid}.pdf`;
  const profileBasename = `filename-preservation-profile-${process.pid}.pdf`;
  const previousResume = `/uploads/missing-previous-resume-${process.pid}.pdf`;
  const previousProfile = `/uploads/missing-previous-profile-${process.pid}.pdf`;
  assert.strictEqual(fs.existsSync(path.join(uploadDir, path.basename(previousResume))), false);
  assert.strictEqual(fs.existsSync(path.join(uploadDir, path.basename(previousProfile))), false);

  const candidate = createCandidate({
    _id: 'candidate-1',
    firstName: 'Anjali',
    updatedResume: previousResume,
    ornnovaProfile: previousProfile,
  });
  let saveCount = 0;
  CandidateModel.findOne = async () => ({
    reqId: 'req-1',
    recruiterId: [],
    candidates: { id: () => candidate },
    save: async () => { saveCount += 1; },
  });

  const resumeResult = await updateCandidateDocuments('candidate-1', {
    updatedResume: [uploadedFile('Anjali_Updated_Resume.pdf', resumeBasename)],
  });
  assert.strictEqual(resumeResult.candidate.updatedResume, `/uploads/${resumeBasename}`);
  assert.strictEqual(resumeResult.candidate.updatedResumeOriginalName, 'Anjali_Updated_Resume.pdf');
  assert.strictEqual(resumeResult.candidate.ornnovaProfile, previousProfile);
  assert.strictEqual(resumeResult.candidate.ornnovaProfileOriginalName, '');
  assert.strictEqual(candidate.firstName, 'Anjali');

  const profileResult = await updateCandidateDocuments('candidate-1', {
    ornnovaProfile: [uploadedFile('Anjali_Ornnova_Profile.pdf', profileBasename)],
  });
  assert.strictEqual(profileResult.candidate.ornnovaProfile, `/uploads/${profileBasename}`);
  assert.strictEqual(profileResult.candidate.ornnovaProfileOriginalName, 'Anjali_Ornnova_Profile.pdf');
  assert.strictEqual(profileResult.candidate.updatedResumeOriginalName, 'Anjali_Updated_Resume.pdf');
  assert.strictEqual(profileResult.candidate.updatedResume, `/uploads/${resumeBasename}`);
  assert.strictEqual(saveCount, 2);

  const storedFileName = `filename-preservation-stored-${process.pid}-${Date.now()}.pdf`;
  const storedAbsolute = path.join(uploadDir, storedFileName);
  assert.strictEqual(fs.existsSync(storedAbsolute), false);
  fs.writeFileSync(storedAbsolute, '%PDF-1.1 test');
  try {
    const named = resolveDocumentForDownload({
      updatedResume: `/uploads/${storedFileName}`,
      updatedResumeOriginalName: 'Anjali_Updated_Resume.pdf',
    }, 'updatedResume');
    assert.strictEqual(named.downloadName, 'Anjali_Updated_Resume.pdf');
    assert.strictEqual(named.absolutePath, storedAbsolute);

    const fallback = resolveDocumentForDownload({
      ornnovaProfile: `/uploads/${storedFileName}`,
    }, 'ornnovaProfile');
    assert.strictEqual(fallback.downloadName, storedFileName);

    const missing = resolveDocumentForDownload({
      updatedResume: '/uploads/does-not-exist-filename-preservation.pdf',
    }, 'updatedResume');
    assert.strictEqual(missing.error.statusCode, 404);
  } finally {
    if (fs.existsSync(storedAbsolute)) fs.unlinkSync(storedAbsolute);
  }

  assert.strictEqual(
    contentDispositionInline('Anjali R A.pdf'),
    'inline; filename="Anjali R A.pdf"; filename*=UTF-8\'\'Anjali%20R%20A.pdf',
  );

  const ticket = signDocumentPreviewTicket({
    userId: 'user-1',
    candidateId: 'candidate-1',
    documentField: 'updatedResume',
  });
  const verified = verifyDocumentPreviewTicket(ticket);
  assert.strictEqual(verified.userId, 'user-1');
  assert.strictEqual(verified.candidateId, 'candidate-1');
  assert.strictEqual(verified.documentField, 'updatedResume');
  assert.strictEqual(verifyDocumentPreviewTicket(`${ticket}tampered`), null);
  assert.strictEqual(verifyDocumentPreviewTicket(''), null);

  const previewPath = buildDocumentPreviewPath(
    'candidate-1',
    'updatedResume',
    'user-1',
    'Anjali R A.pdf',
  );
  assert.ok(previewPath.startsWith(
    '/api/candidates/candidate-1/documents/updatedResume/Anjali%20R%20A.pdf?ticket=',
  ));

  const expiredBody = Buffer.from(JSON.stringify({
    purpose: 'candidate-document-preview',
    userId: 'user-1',
    candidateId: 'candidate-1',
    documentField: 'updatedResume',
    exp: Date.now() - 1000,
  })).toString('base64url');
  const { JWT_SECRET } = require('../config/env');
  const expiredSignature = require('crypto').createHmac('sha256', JWT_SECRET).update(expiredBody).digest('base64url');
  assert.strictEqual(verifyDocumentPreviewTicket(`${expiredBody}.${expiredSignature}`), null);

  NewUser.findById = () => ({
    select() {
      return this;
    },
    lean: async () => ({
      _id: 'user-1',
      Email: 'hr@example.com',
      UserType: 'HR',
      Status: 'Active',
      EmployeeName: 'HR User',
    }),
  });

  const ticketForRoute = signDocumentPreviewTicket({
    userId: 'user-1',
    candidateId: 'candidate-1',
    documentField: 'updatedResume',
  });
  const ticketUser = await authenticateDocumentPreviewTicket({
    method: 'GET',
    path: '/api/candidates/candidate-1/documents/updatedResume/Anjali R A.pdf',
    query: { ticket: ticketForRoute },
  });
  assert.strictEqual(ticketUser.id, 'user-1');
  assert.strictEqual(ticketUser.role, 'HR');

  const wrongDocument = await authenticateDocumentPreviewTicket({
    method: 'GET',
    path: '/api/candidates/other-candidate/documents/updatedResume',
    query: { ticket: ticketForRoute },
  });
  assert.strictEqual(wrongDocument, null);

  const response = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await authMiddleware({
    method: 'GET',
    path: '/api/candidates/candidate-1/documents/updatedResume',
    url: '/api/candidates/candidate-1/documents/updatedResume',
    headers: {},
    query: { ticket: 'not-a-ticket' },
  }, response, () => { throw new Error('invalid ticket must not pass'); });
  assert.strictEqual(response.statusCode, 401);

  let passed = false;
  await authMiddleware({
    method: 'GET',
    path: '/api/candidates/candidate-1/documents/updatedResume/Anjali R A.pdf',
    url: '/api/candidates/candidate-1/documents/updatedResume/Anjali%20R%20A.pdf',
    headers: {},
    query: { ticket: ticketForRoute },
  }, response, () => { passed = true; });
  assert.strictEqual(passed, true);

  console.log('candidate document filename tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
