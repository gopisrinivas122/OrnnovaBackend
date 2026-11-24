const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { isOfferWorkflowEnabled } = require('../utils/offerFeatureFlag');
const { offerWorkflowService, OfferWorkflowError } = require('../services/offerWorkflow.service');
const { offerDocumentUpload, safeUnlink } = require('../config/offerDocumentUpload');

function sendOfferError(res, error) {
  const body = {
    status: 'Failed',
    msg: error.message,
    code: error.code || 'OFFER_ERROR',
  };
  if (error.details) body.details = error.details;
  return res.status(error.statusCode || 400).json(body);
}

function offerHandler(handler) {
  return asyncHandler(async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (error && error.isOfferWorkflowError) {
        return sendOfferError(res, error);
      }
      return next(error);
    }
  });
}

function tokenUser(req) {
  if (!req.user?.id || !req.user?.role) {
    throw new OfferWorkflowError('Authentication required.', 401, 'AUTH_REQUIRED');
  }
  return {
    id: req.user.id,
    role: req.user.role,
    name: req.user.name || '',
  };
}

function correlationId(req) {
  return req.get('x-request-id') || '';
}

function registerOfferRoutes(app, service = offerWorkflowService) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!isOfferWorkflowEnabled()) {
      return res.status(403).json({
        status: 'Failed',
        msg: 'Offer workflow is disabled.',
        code: 'OFFER_WORKFLOW_DISABLED',
      });
    }
    return next();
  });

  router.post('/', offerHandler(async (req, res) => {
    const result = await service.initiateOffer({
      tokenUser: tokenUser(req),
      candidateSubdocumentId: req.body?.candidateSubdocumentId,
      recipientUserId: req.body?.recipientUserId,
      teamLeadUserId: req.body?.teamLeadUserId,
      draft: {
        candidate: req.body?.candidate,
        employment: req.body?.employment,
        client: req.body?.client,
        commercial: req.body?.commercial,
        additionalRemarks: req.body?.additionalRemarks,
      },
      correlationId: correlationId(req),
    });
    return res.status(201).json({
      status: 'Success',
      msg: result.warning || `Offer ${result.offer?.offerRequestNumber || ''} created.`,
      data: result.offer,
      canOpen: result.canOpen === true,
      warning: result.warning || '',
    });
  }));

  router.get('/', offerHandler(async (req, res) => {
    const data = await service.listOffers({ tokenUser: tokenUser(req), query: req.query });
    return res.json({ status: 'Success', msg: 'Offer requests fetched', data });
  }));

  router.get('/recipients', offerHandler(async (req, res) => {
    const data = await service.listInitiationRecipients({
      tokenUser: tokenUser(req),
      candidateSubdocumentId: req.query.candidateSubdocumentId,
    });
    return res.json({ status: 'Success', msg: 'Offer recipients fetched', data });
  }));

  router.get('/open-indicators', offerHandler(async (req, res) => {
    const data = await service.listOpenOfferIndicators({ tokenUser: tokenUser(req) });
    return res.json({ status: 'Success', msg: 'Open offer indicators fetched', data });
  }));

  router.get('/:id', offerHandler(async (req, res) => {
    const data = await service.getOffer({ tokenUser: tokenUser(req), offerId: req.params.id });
    return res.json({ status: 'Success', msg: 'Offer request fetched', data });
  }));

  router.patch('/:id/draft', offerHandler(async (req, res) => {
    const result = await service.saveDraft({
      tokenUser: tokenUser(req),
      offerId: req.params.id,
      payload: req.body,
    });
    return res.json({ status: 'Success', msg: 'Offer draft saved', data: result.offer });
  }));

  router.post('/:id/submit', offerHandler(async (req, res) => {
    const result = await service.applyTransition({
      tokenUser: tokenUser(req),
      offerId: req.params.id,
      action: 'submit_to_hr',
      comments: req.body?.comments,
      correlationId: correlationId(req),
    });
    return res.json({
      status: 'Success',
      msg: result.warning || 'Offer request submitted to HR',
      data: result.offer,
      warning: result.warning || '',
    });
  }));

  router.post('/:id/documents', offerHandler(async (req, res, next) => {
    await service.assertDocumentUploadAllowed({
      tokenUser: tokenUser(req),
      offerId: req.params.id,
    });
    return next();
  }), (req, res, next) => {
    offerDocumentUpload.single('file')(req, res, (error) => {
      if (!error) return next();
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'File exceeds the 5 MB limit.'
        : error.message;
      return res.status(400).json({ status: 'Failed', msg: message, code: 'INVALID_FILE' });
    });
  }, offerHandler(async (req, res) => {
    try {
      const result = await service.attachDocument({
        tokenUser: tokenUser(req),
        offerId: req.params.id,
        documentType: req.body?.documentType,
        remarks: req.body?.remarks,
        file: req.file ? {
          storageKey: req.file.filename,
          originalFilename: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size,
          path: req.file.path,
        } : null,
      });
      return res.status(201).json({ status: 'Success', msg: 'Document uploaded', data: result.offer });
    } catch (error) {
      if (!error || error.code !== 'HISTORY_WRITE_FAILED') {
        await safeUnlink(req.file?.path);
      }
      throw error;
    }
  }));

  router.delete('/:id/documents/:documentId', offerHandler(async (req, res) => {
    const result = await service.removeDocument({
      tokenUser: tokenUser(req),
      offerId: req.params.id,
      documentId: req.params.documentId,
    });
    return res.json({ status: 'Success', msg: 'Document deleted', data: result.offer });
  }));

  router.get('/:id/documents/:documentId', offerHandler(async (req, res) => {
    const file = await service.resolveDownload({
      tokenUser: tokenUser(req),
      offerId: req.params.id,
      documentId: req.params.documentId,
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.originalFilename.replace(/["\r\n]/g, '')}"`);
    return res.sendFile(file.absolutePath);
  }));

  router.post('/:id/transition', offerHandler(async (req, res) => {
    const result = await service.applyTransition({
      tokenUser: tokenUser(req),
      offerId: req.params.id,
      action: req.body?.action,
      comments: req.body?.comments,
      returnTarget: req.body?.returnTarget,
      documentVerifications: req.body?.documentVerifications,
      hrRemarks: req.body?.hrRemarks,
      correlationId: correlationId(req),
    });
    return res.json({
      status: 'Success',
      msg: result.warning || result.message || 'Offer request updated',
      data: result.offer,
      warning: result.warning || '',
    });
  }));

  app.use('/api/offers', router);
}

module.exports = registerOfferRoutes;
