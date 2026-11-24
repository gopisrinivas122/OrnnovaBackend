const {
  HR_READ_STATUSES,
  TL_EDIT_STATUSES,
  HR_INBOX_STATUSES,
  HR_RELEASE_STATUSES,
} = require('../utils/offerWorkflow.constants');

function isAssignedToTeamLead(actor, offer) {
  if (!actor || actor.role !== 'TeamLead' || !offer) return false;
  if (offer.currentAssigneeRole !== 'TeamLead') return false;
  const assigneeUserId = String(offer.currentAssigneeUserId || '').trim();
  if (assigneeUserId) return assigneeUserId === actor.id;
  return offer.responsibleTeamLeadUserId === actor.id;
}

/** Mongo clause: offers currently assigned to this Team Lead. */
function teamLeadAssignmentAccess(actor) {
  return [
    { currentAssigneeRole: 'TeamLead', currentAssigneeUserId: actor.id },
    {
      currentAssigneeRole: 'TeamLead',
      responsibleTeamLeadUserId: actor.id,
      currentAssigneeUserId: '',
    },
    {
      currentAssigneeRole: 'TeamLead',
      responsibleTeamLeadUserId: actor.id,
      currentAssigneeUserId: null,
    },
    {
      currentAssigneeRole: 'TeamLead',
      responsibleTeamLeadUserId: actor.id,
      currentAssigneeUserId: { $exists: false },
    },
  ];
}

/**
 * TL "All Requests" queue — only stages where the TL is the active assignee for work,
 * not historical responsibility or post-release actor assignment.
 */
function teamLeadAllRequestsStatusClause() {
  return {
    $or: [
      {
        currentStatus: {
          $in: TL_EDIT_STATUSES,
        },
      },
      { currentStatus: 'Returned by Admin', currentAssigneeRole: 'TeamLead' },
    ],
  };
}

function canReadOffer(actor, offer) {
  if (!actor || !offer) return false;
  if (actor.role === 'Admin') return true;
  if (actor.role === 'TeamLead') {
    return isAssignedToTeamLead(actor, offer);
  }
  if (actor.role === 'HR') {
    if (TL_EDIT_STATUSES.includes(offer.currentStatus)) return true;
    if (offer.currentStatus === 'Returned by Admin' && offer.currentAssigneeRole === 'TeamLead') return true;
    if (offer.currentAssigneeRole === 'TeamLead' && !HR_READ_STATUSES.includes(offer.currentStatus)) return false;
    if (HR_READ_STATUSES.includes(offer.currentStatus)) return true;
    return offer.currentStatus === 'Returned by Admin' && offer.currentAssigneeRole === 'HR';
  }
  return false;
}

function canEditDraft(actor, offer) {
  if (!actor || actor.role !== 'TeamLead' || !offer) return false;
  if (!isAssignedToTeamLead(actor, offer)) return false;
  if (TL_EDIT_STATUSES.includes(offer.currentStatus)) return true;
  return offer.currentStatus === 'Returned by Admin' && offer.currentAssigneeRole === 'TeamLead';
}

function canEditOfferDetails(actor, offer) {
  if (!canReadOffer(actor, offer) || !offer.currentStatus) return false;
  if (['Offer Released', 'Offer Accepted', 'Onboard Confirmation', 'Joined', 'Cancelled', 'Candidate Declined'].includes(offer.currentStatus)) {
    return false;
  }
  if (actor.role === 'Admin') return true;
  if (actor.role === 'TeamLead') return canEditDraft(actor, offer);
  if (actor.role === 'HR') {
    if (TL_EDIT_STATUSES.includes(offer.currentStatus)) return true;
    if (offer.currentStatus === 'Returned by Admin' && offer.currentAssigneeRole === 'TeamLead') return true;
    if (HR_INBOX_STATUSES.includes(offer.currentStatus)) return true;
    if (HR_RELEASE_STATUSES.includes(offer.currentStatus)) return true;
    return offer.currentStatus === 'Returned by Admin' && offer.currentAssigneeRole === 'HR';
  }
  return false;
}

function letterPreparationSourceClause(source) {
  if (source === 'admin') return { letterPreparationSource: 'admin' };
  if (source === 'md') {
    return {
      $or: [
        { letterPreparationSource: 'md' },
        { letterPreparationSource: { $in: ['', null] } },
        { letterPreparationSource: { $exists: false } },
      ],
    };
  }
  return null;
}

function statusSelectionClause(filters = {}) {
  const statuses = Array.isArray(filters.statuses)
    ? filters.statuses.filter(Boolean)
    : (filters.status ? [filters.status] : []);
  const returnedAssigneeRole = filters.returnedAssigneeRole || '';
  const letterPreparationSource = filters.letterPreparationSource || '';
  if (!statuses.length && !returnedAssigneeRole && !letterPreparationSource) return null;

  const statusParts = [];
  if (statuses.length === 1 && !returnedAssigneeRole) {
    statusParts.push({ currentStatus: statuses[0] });
  } else if (statuses.length) {
    statusParts.push({ currentStatus: { $in: statuses } });
  }
  if (returnedAssigneeRole) {
    statusParts.push({
      currentStatus: 'Returned by Admin',
      currentAssigneeRole: returnedAssigneeRole,
    });
  }

  let statusClause = null;
  if (statusParts.length === 1) statusClause = statusParts[0];
  else if (statusParts.length > 1) statusClause = { $or: statusParts };

  const sourceClause = letterPreparationSourceClause(letterPreparationSource);
  if (statusClause && sourceClause) return { $and: [statusClause, sourceClause] };
  return statusClause || sourceClause;
}

function buildOfferListFilter(actor, filters = {}) {
  if (!actor) return { _id: null };

  const access = [];
  if (actor.role === 'Admin') {
    access.push({});
  } else if (actor.role === 'TeamLead') {
    access.push(...teamLeadAssignmentAccess(actor));
  } else if (actor.role === 'HR') {
    access.push({ currentStatus: { $in: [...HR_READ_STATUSES, ...TL_EDIT_STATUSES] } });
    access.push({ currentStatus: 'Returned by Admin', currentAssigneeRole: 'HR' });
    access.push({ currentStatus: 'Returned by Admin', currentAssigneeRole: 'TeamLead' });
  } else {
    return { _id: null };
  }

  const clauses = access.length === 1 ? [] : [{ $or: access }];
  const filter = access.length === 1 ? { ...access[0] } : { $and: clauses };

  const statusClause = statusSelectionClause(filters);
  if (statusClause) {
    if (filter.$and) filter.$and.push(statusClause);
    else Object.assign(filter, statusClause);
  } else if (actor.role === 'TeamLead') {
    const allRequestsClause = teamLeadAllRequestsStatusClause();
    if (filter.$and) filter.$and.push(allRequestsClause);
    else {
      const existing = { ...filter };
      Object.keys(filter).forEach((key) => { delete filter[key]; });
      filter.$and = [existing, allRequestsClause];
    }
  }

  if (filters.search) {
    const searchClause = { $or: filters.search };
    if (filter.$and) filter.$and.push(searchClause);
    else if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, searchClause];
      delete filter.$or;
    } else {
      filter.$and = [searchClause];
    }
  }

  return filter;
}

module.exports = {
  canReadOffer,
  canEditDraft,
  canEditOfferDetails,
  buildOfferListFilter,
  isAssignedToTeamLead,
  teamLeadAllRequestsStatusClause,
};
