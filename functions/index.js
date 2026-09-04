const { initializeApp } = require('firebase-admin/app');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');

initializeApp();

exports.aggregateProcessedLabels = onDocumentCreated({
  document: 'users/{uid}/labelBatches/{batchId}',
  region: 'asia-south1',
  memory: '256MiB'
}, async event => {
  const data = event.data?.data();
  if (!data) return;
  const totalOrders = Math.min(5000, Math.max(0, Math.round(Number(data.totalOrders) || 0)));
  const totalPieces = Math.min(50000, Math.max(0, Math.round(Number(data.totalPieces) || 0)));
  const platform = data.platform === 'meesho' ? 'meesho' : 'flipkart';
  if (!totalOrders || totalPieces < totalOrders) return;

  const db = getFirestore();
  const platformOrders = platform === 'meesho' ? 'meeshoOrders' : 'flipkartOrders';
  const platformPieces = platform === 'meesho' ? 'meeshoPieces' : 'flipkartPieces';
  const increments = {
    labelCount: FieldValue.increment(totalOrders),
    piecesCount: FieldValue.increment(totalPieces),
    batchesCount: FieldValue.increment(1),
    [platformOrders]: FieldValue.increment(totalOrders),
    [platformPieces]: FieldValue.increment(totalPieces),
    updatedAt: Date.now()
  };

  await Promise.all([
    db.doc('publicStats/usage').set(increments, { merge: true }),
    db.doc(`users/${event.params.uid}/stats/labels`).set(increments, { merge: true })
  ]);
});

exports.deleteExpiredSellerPdfs = onSchedule({
  schedule: 'every 10 minutes',
  timeZone: 'Asia/Kolkata',
  memory: '256MiB',
  timeoutSeconds: 180
}, async () => {
  const db = getFirestore();
  const snapshot = await db.collectionGroup('pdfs')
    .where('expiresAt', '<=', Date.now())
    .limit(400)
    .get();

  if (snapshot.empty) return;
  const bucket = getStorage().bucket();
  await Promise.all(snapshot.docs.map(async document => {
    const data = document.data();
    if (data.storagePath) {
      await bucket.file(data.storagePath).delete({ ignoreNotFound: true });
    }
    await document.ref.delete();
  }));
});
