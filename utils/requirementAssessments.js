const MIN_ASSESSMENTS = 5;

function parseAssessmentsInput(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }
  return [];
}

function normalizeAssessments(assessments = []) {
  return assessments
    .map((item) => ({
      assessment: String(item?.assessment || '').trim(),
      yoe: String(item?.yoe || '').trim(),
    }))
    .filter((item) => item.assessment && item.yoe);
}

function validateAssessments(rawAssessments) {
  const assessments = normalizeAssessments(parseAssessmentsInput(rawAssessments));

  if (assessments.length < MIN_ASSESSMENTS) {
    return {
      ok: false,
      message: `Minimum ${MIN_ASSESSMENTS} assessments are required.`,
      assessments,
    };
  }

  return { ok: true, assessments };
}

module.exports = {
  MIN_ASSESSMENTS,
  parseAssessmentsInput,
  normalizeAssessments,
  validateAssessments,
};
