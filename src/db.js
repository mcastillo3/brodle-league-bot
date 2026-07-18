/**
 * Firestore layer.
 *
 * Collections:
 *   scores/{puzzle}_{userId}   one doc per player per puzzle (idempotent — reposts overwrite)
 *   weeks/{weekId}             written when a week is announced; stores standings + winner(s)
 */

const admin = require('firebase-admin');
const path = require('path');

admin.initializeApp({
  credential: admin.credential.cert(require(path.join(__dirname, '..', 'serviceAccountKey.json'))),
});
const db = admin.firestore();

/** Save (or overwrite) one player's score for one puzzle. Returns 'new' | 'updated'. */
async function saveScore({ userId, username, puzzle, score, failed, hardMode, weekId, monthId }) {
  const ref = db.collection('scores').doc(`${puzzle}_${userId}`);
  const existing = await ref.get();
  await ref.set({
    userId, username, puzzle, score, failed, hardMode, weekId, monthId,
    postedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return existing.exists ? 'updated' : 'new';
}

async function scoresForWeek(weekId) {
  const snap = await db.collection('scores').where('weekId', '==', weekId).get();
  return snap.docs.map((d) => d.data());
}

async function scoresForMonth(monthId) {
  const snap = await db.collection('scores').where('monthId', '==', monthId).get();
  return snap.docs.map((d) => d.data());
}

async function allScores() {
  const snap = await db.collection('scores').get();
  return snap.docs.map((d) => d.data());
}

async function scoresForPlayer(userId) {
  const snap = await db.collection('scores').where('userId', '==', userId).get();
  return snap.docs.map((d) => d.data());
}

/** Persist a finished week's standings and winner(s). Idempotent by weekId. */
async function recordWeekResult(weekId, standings, winnerIds) {
  await db.collection('weeks').doc(weekId).set({
    weekId,
    standings,   // [{userId, username, total, average, played, fails}]
    winnerIds,
    announcedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function weekAlreadyAnnounced(weekId) {
  const doc = await db.collection('weeks').doc(weekId).get();
  return doc.exists;
}

/** Spreadsheet-era win tallies written by the backfill script (may not exist). */
async function legacyWins() {
  const doc = await db.collection('meta').doc('legacyWins').get();
  return doc.exists ? doc.data() : { alltime: {}, currentSeason: {} };
}

/** Weekly titles per userId: bot-era wins + spreadsheet-era recorded tallies. */
async function weeklyWinCounts() {
  const [snap, legacy] = await Promise.all([db.collection('weeks').get(), legacyWins()]);
  const counts = { ...(legacy.alltime || {}) };
  for (const doc of snap.docs) {
    for (const id of doc.data().winnerIds || []) counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

/** Weekly titles per userId for weeks on/after a given weekId (season = calendar year).
 *  Includes the spreadsheet's current-season tallies, since the running season
 *  continued from the sheet into the bot era. */
async function weeklyWinCountsSince(minWeekId) {
  const [snap, legacy] = await Promise.all([
    db.collection('weeks').where('weekId', '>=', minWeekId).get(), legacyWins(),
  ]);
  const counts = { ...(legacy.currentSeason || {}) };
  for (const doc of snap.docs) {
    for (const id of doc.data().winnerIds || []) counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

/** Current champion theme (colors + emoji + championId). Null if never set. */
async function getTheme() {
  const doc = await db.collection('meta').doc('theme').get();
  return doc.exists ? doc.data() : null;
}

async function setTheme(theme) {
  await db.collection('meta').doc('theme').set(theme, { merge: true });
}

/** userId of the most recently announced week's winner (the reigning champion). */
async function currentChampionId() {
  const snap = await db.collection('weeks').orderBy('weekId', 'desc').limit(1).get();
  if (snap.empty) return null;
  const ids = snap.docs[0].data().winnerIds || [];
  return ids[0] || null; // if co-champions, the first listed holds theme rights
}

module.exports = {
  saveScore, scoresForWeek, scoresForMonth, allScores,
  scoresForPlayer, recordWeekResult, weekAlreadyAnnounced, weeklyWinCounts,
  weeklyWinCountsSince, getTheme, setTheme, currentChampionId,
};
