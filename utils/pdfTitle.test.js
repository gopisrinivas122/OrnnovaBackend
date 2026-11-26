const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPdfTitleIncrement, stampUploadedPdfTitle } = require('./pdfTitle');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const samplePath = path.join(__dirname, '..', 'uploads', '1795516839972.pdf');
const originalSample = fs.readFileSync(samplePath);
const originalHash = sha256(originalSample);

const updated = buildPdfTitleIncrement(originalSample, 'Anjali R A.pdf');
assert.ok(updated, 'incremental title update should be created');
assert.ok(updated.subarray(0, originalSample.length).equals(originalSample));
assert.ok(updated.includes(Buffer.from('/Title (Anjali R A.pdf)')));
assert.strictEqual(sha256(fs.readFileSync(samplePath)), originalHash);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-title-'));
const tempPdf = path.join(tempDir, 'resume.pdf');
const tempDocx = path.join(tempDir, 'resume.docx');
fs.writeFileSync(tempPdf, originalSample);
fs.writeFileSync(tempDocx, originalSample);

assert.strictEqual(stampUploadedPdfTitle(tempDocx, 'Anjali R A.pdf'), false);
assert.ok(fs.readFileSync(tempDocx).equals(originalSample));
assert.strictEqual(stampUploadedPdfTitle(tempPdf, 'Anjali R A.pdf'), true);
const stamped = fs.readFileSync(tempPdf);
assert.ok(stamped.subarray(0, originalSample.length).equals(originalSample));
assert.ok(stamped.includes(Buffer.from('/Title (Anjali R A.pdf)')));
assert.ok(stamped.includes(Buffer.from('/Producer (ReportLab PDF Library - \\(opensource\\))')));
assert.strictEqual(sha256(fs.readFileSync(samplePath)), originalHash);

const nonPdf = Buffer.from('not a pdf');
assert.strictEqual(buildPdfTitleIncrement(nonPdf, 'Anjali R A.pdf'), null);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('pdf title tests passed');
