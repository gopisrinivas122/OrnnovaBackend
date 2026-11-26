#!/usr/bin/env node
/**
 * One-time data fix: deactivate the MD user and reassign ORN-011 to HR Verification.
 * Does not delete users, offers, history, or notifications.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { ACTIVE_STATUS, INACTIVE_STATUS } = require('../utils/constants');
const { buildOfferSourceEventId, createOfferWorkflowNotification } = require('../services/offerNotification.service');

const MD_USER_ID = '6adf4bedd90572d761fc916b';
const OFFER_NUMBER = 'ORN-011';

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set');
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  if (db.databaseName !== 'HR') {
    throw new Error(`Refusing to run against database "${db.databaseName}". Expected HR.`);
  }

  const Users = db.collection('users');
  const Offers = db.collection('offer_requests');
  const History = db.collection('offer_approval_histories');
  const Notifications = db.collection('notifications');

  const mdUser = await Users.findOne({ _id: new mongoose.Types.ObjectId(MD_USER_ID) });
  if (!mdUser) {
    throw new Error(`MD user ${MD_USER_ID} was not found`);
  }
  if (mdUser.UserType !== 'MD' || mdUser.EmpCode !== 'EMP011') {
    throw new Error('MD user record did not match the expected EmpCode/UserType');
  }

  const offer = await Offers.findOne({
    $or: [
      { offerRequestNumber: OFFER_NUMBER },
      { _id: new mongoose.Types.ObjectId('6ae82491e5c3b02797d08424') },
    ],
  });

  const hrUsers = await Users.find({ UserType: 'HR', Status: ACTIVE_STATUS }).project({ Password: 0, token: 0, verifytoken: 0 }).toArray();
  if (!hrUsers.length) {
    throw new Error('No Active HR user was found for reassignment');
  }
  const hrUser = hrUsers[0];

  const relatedHistory = offer
    ? await History.find({ offerRequestId: String(offer._id) }).toArray()
    : [];
  const relatedNotifications = await Notifications.find({
    $or: [
      { recipientUserId: MD_USER_ID },
      { actorUserId: MD_USER_ID },
      { title: /ORN-011/ },
      { message: /ORN-011/ },
      { link: '/offers/6ae82491e5c3b02797d08424' },
    ],
  }).toArray();

  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `md-role-removal-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    database: db.databaseName,
    createdAt: new Date().toISOString(),
    mdUser: { ...mdUser, Password: undefined, token: undefined, verifytoken: undefined },
    offer,
    relatedHistory,
    relatedNotifications,
    hrUser,
  }, null, 2));

  const userResult = await Users.updateOne(
    { _id: mdUser._id, UserType: 'MD', EmpCode: 'EMP011' },
    { $set: { Status: INACTIVE_STATUS } },
  );
  if (userResult.matchedCount !== 1) {
    throw new Error('MD user deactivate update did not match the expected record');
  }

  const now = new Date();
  let reassignedOffer = null;
  let historyAction = null;
  let offerSkipReason = null;

  if (!offer) {
    offerSkipReason = 'ORN-011 is no longer present in offer_requests (collection is empty). Historical notifications were preserved and the offer was not recreated.';
  } else {
    const offerResult = await Offers.updateOne(
      {
        _id: offer._id,
        isOpen: true,
        currentAssigneeRole: 'MD',
      },
      {
        $set: {
          currentStatus: 'HR Review',
          currentAssigneeRole: 'HR',
          currentAssigneeUserId: String(hrUser._id),
          currentAssigneeName: hrUser.EmployeeName || 'HR',
          updatedAt: now,
        },
        $inc: { workflowVersion: 1 },
      },
    );
    if (offerResult.matchedCount !== 1) {
      throw new Error('ORN-011 reassignment did not match the expected open MD-assigned record');
    }

    const historyDoc = {
      offerRequestId: String(offer._id),
      action: 'reassign_to_hr',
      previousStatus: offer.currentStatus,
      newStatus: 'HR Review',
      actorUserId: 'system',
      actorRole: 'System',
      comments: 'Reassigned to HR Verification because the MD role was removed from the application. The earlier Admin return-to-MD history is preserved.',
      correlationId: 'md-role-removal',
      createdAt: now,
    };
    const historyInsert = await History.insertOne(historyDoc);
    historyAction = historyDoc.action;

    await createOfferWorkflowNotification({
      recipientUserId: String(hrUser._id),
      title: `Offer ${OFFER_NUMBER} · Pending HR Verification`,
      message: `${OFFER_NUMBER} was reassigned to HR Verification after the MD role was removed.`,
      link: `/offers/${String(offer._id)}`,
      actorUserId: 'system',
      sourceEventId: buildOfferSourceEventId(String(offer._id), String(historyInsert.insertedId)),
    });

    const updatedOffer = await Offers.findOne({ _id: offer._id });
    reassignedOffer = {
      id: String(updatedOffer._id),
      offerRequestNumber: updatedOffer.offerRequestNumber,
      currentStatus: updatedOffer.currentStatus,
      currentAssigneeRole: updatedOffer.currentAssigneeRole,
      currentAssigneeUserId: updatedOffer.currentAssigneeUserId,
      currentAssigneeName: updatedOffer.currentAssigneeName,
      isOpen: updatedOffer.isOpen,
      workflowVersion: updatedOffer.workflowVersion,
    };
  }

  const updatedUser = await Users.findOne({ _id: mdUser._id }, { projection: { Password: 0, token: 0, verifytoken: 0 } });

  console.log(JSON.stringify({
    ok: true,
    database: db.databaseName,
    backupPath,
    deactivatedUser: {
      id: String(updatedUser._id),
      name: updatedUser.EmployeeName,
      empCode: updatedUser.EmpCode,
      userType: updatedUser.UserType,
      status: updatedUser.Status,
    },
    reassignedOffer,
    offerSkipReason,
    historyAction,
    hrAssignee: {
      id: String(hrUser._id),
      name: hrUser.EmployeeName,
      empCode: hrUser.EmpCode,
    },
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
