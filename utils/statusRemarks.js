function compareStatusHistoryEntries(a, b, indexA = 0, indexB = 0) {
  const dateDiff = new Date(a?.Date || 0) - new Date(b?.Date || 0);
  if (dateDiff !== 0) return dateDiff;

  if (a?._id && b?._id) {
    return String(a._id).localeCompare(String(b._id));
  }

  return indexA - indexB;
}

function sortStatusHistoryChronologically(statusHistory = []) {
  return [...statusHistory]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareStatusHistoryEntries(a.entry, b.entry, a.index, b.index))
    .map(({ entry }) => entry);
}

function getLatestStatusEntry(statusHistory = []) {
  if (!Array.isArray(statusHistory) || statusHistory.length === 0) return null;

  let latest = statusHistory[0];
  let latestIndex = 0;

  statusHistory.forEach((entry, index) => {
    if (compareStatusHistoryEntries(entry, latest, index, latestIndex) > 0) {
      latest = entry;
      latestIndex = index;
    }
  });

  return latest;
}

function normalizeRemarkEntry(entry, fallbackDate) {
  if (!entry) return null;
  const text = String(entry.text || entry.Remark || entry.remark || '').trim();
  if (!text) return null;
  return {
    text,
    createdAt: entry.createdAt || entry.Date || entry.date || fallbackDate || new Date(),
  };
}

function getStatusRemarkEntries(statusEntry) {
  if (!statusEntry) return [];

  const remarks = Array.isArray(statusEntry.Remarks) ? statusEntry.Remarks : [];
  const normalized = remarks
    .map((entry) => normalizeRemarkEntry(entry, statusEntry.Date))
    .filter(Boolean);

  if (normalized.length > 0) {
    return normalized.sort(
      (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );
  }

  const legacyRemark = String(statusEntry.Remark || statusEntry.remark || '').trim();
  if (!legacyRemark) return [];

  return [{
    text: legacyRemark,
    createdAt: statusEntry.Date || new Date(),
  }];
}

function serializeStatusEntry(statusEntry) {
  if (!statusEntry) return statusEntry;
  const plain = typeof statusEntry.toObject === 'function'
    ? statusEntry.toObject()
    : { ...statusEntry };

  return {
    ...plain,
    Remarks: getStatusRemarkEntries(plain),
  };
}

function serializeCandidateStatusHistory(candidate) {
  if (!candidate) return candidate;
  const plain = typeof candidate.toObject === 'function'
    ? candidate.toObject()
    : { ...candidate };

  const statusHistory = Array.isArray(plain.Status)
    ? plain.Status.map(serializeStatusEntry)
    : [];
  const sortedHistory = sortStatusHistoryChronologically(statusHistory);
  const latestEntry = getLatestStatusEntry(sortedHistory);

  return {
    ...plain,
    currentStatus: latestEntry?.Status || '',
    latestStatusEntryId: latestEntry?._id ? String(latestEntry._id) : '',
    Status: sortedHistory,
  };
}

function ensureStatusEntryRemarksArray(statusEntry) {
  if (!statusEntry.Remarks || !Array.isArray(statusEntry.Remarks)) {
    statusEntry.Remarks = [];
  }

  if (statusEntry.Remarks.length === 0) {
    const legacyRemark = String(statusEntry.Remark || statusEntry.remark || '').trim();
    if (legacyRemark) {
      statusEntry.Remarks.push({
        text: legacyRemark,
        createdAt: statusEntry.Date || new Date(),
      });
    }
  }

  return statusEntry;
}

function appendRemarkToStatusEntry(statusEntry, remarkText) {
  const trimmed = String(remarkText || '').trim();
  if (!trimmed) {
    return { ok: false, message: 'Remark is required.' };
  }

  ensureStatusEntryRemarksArray(statusEntry);
  statusEntry.Remarks.push({
    text: trimmed,
    createdAt: new Date(),
  });

  return { ok: true, remark: trimmed };
}

module.exports = {
  compareStatusHistoryEntries,
  sortStatusHistoryChronologically,
  getStatusRemarkEntries,
  getLatestStatusEntry,
  serializeStatusEntry,
  serializeCandidateStatusHistory,
  ensureStatusEntryRemarksArray,
  appendRemarkToStatusEntry,
};
