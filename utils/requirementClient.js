const NewClient = require('../models/Client');
const NewRequirment = require('../models/Requirement');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadClientLookups() {
  const clients = await NewClient.find().select('_id ClientName').lean();
  const nameById = new Map();
  const idByNameLower = new Map();

  clients.forEach((client) => {
    const id = String(client._id);
    const name = client.ClientName || '';
    nameById.set(id, name);
    if (name.trim()) {
      idByNameLower.set(name.trim().toLowerCase(), id);
    }
  });

  return { nameById, idByNameLower };
}

function applyClientResolutionToDoc(doc, nameById, idByNameLower) {
  if (!doc) return doc;

  const plain = doc.toObject ? doc.toObject() : { ...doc };
  let clientId = plain.clientId ? String(plain.clientId).trim() : '';

  if (!clientId && plain.client) {
    const matchedId = idByNameLower.get(String(plain.client).trim().toLowerCase());
    if (matchedId) clientId = matchedId;
  }

  if (clientId && nameById.has(clientId)) {
    plain.clientId = clientId;
    plain.client = nameById.get(clientId);
  } else if (clientId) {
    plain.clientId = clientId;
  }

  return plain;
}

async function enrichRequirementWithClientName(requirement) {
  if (!requirement) return requirement;
  const lookups = await loadClientLookups();
  return applyClientResolutionToDoc(requirement, lookups.nameById, lookups.idByNameLower);
}

async function enrichRequirementsWithClientNames(requirements) {
  if (!Array.isArray(requirements) || requirements.length === 0) {
    return requirements || [];
  }

  const lookups = await loadClientLookups();
  return requirements.map((req) => applyClientResolutionToDoc(req, lookups.nameById, lookups.idByNameLower));
}

async function syncRequirementsForClientRename(clientId, previousClientName, newClientName) {
  const id = String(clientId || '').trim();
  const nextName = String(newClientName || '').trim();
  if (!id || !nextName) return;

  await NewRequirment.updateMany(
    { clientId: id },
    { $set: { client: nextName } }
  );

  const previousName = String(previousClientName || '').trim();
  if (!previousName || previousName.toLowerCase() === nextName.toLowerCase()) {
    return;
  }

  const legacyFilter = {
    $or: [{ clientId: { $exists: false } }, { clientId: null }, { clientId: '' }],
    client: new RegExp(`^${escapeRegExp(previousName)}$`, 'i'),
  };

  await NewRequirment.updateMany(legacyFilter, {
    $set: { client: nextName, clientId: id },
  });
}

async function resolveRequirementClientUpdate(updateData = {}) {
  if (!Object.prototype.hasOwnProperty.call(updateData, 'clientId')) {
    return updateData;
  }

  const clientId = String(updateData.clientId || '').trim();
  if (!clientId) {
    updateData.clientId = '';
    return updateData;
  }

  const client = await NewClient.findById(clientId).select('_id ClientName').lean();
  if (!client) {
    return updateData;
  }

  updateData.clientId = String(client._id);
  updateData.client = client.ClientName;
  return updateData;
}

module.exports = {
  applyClientResolutionToDoc,
  enrichRequirementWithClientName,
  enrichRequirementsWithClientNames,
  syncRequirementsForClientRename,
  resolveRequirementClientUpdate,
  loadClientLookups,
};
