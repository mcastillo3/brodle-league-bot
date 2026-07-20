/**
 * Firestore layer.
 *
 * Collections:
 *   scores/{puzzle}_{userId}   one doc per player per puzzle (idempotent — reposts overwrite)
 *   weeks/{weekId}             written when a week is announced; stores standings + winner(s)
 */

const admin = require('firebase-admin');
const path = require('path');

// Load the service account credential from either:
//   1. FIREBASE_SERVICE_ACCOUNT env var — the full JSON as a string (for Railway
//      and other hosts where you paste secrets instead of committing files), or
//   2. serviceAccountKey.json in the project root (local development).
// The file is gitignored, so the env-var path is what production uses.
function loadCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON: ' + e.message);
    }
  }
  return require(path.join(__dirname, '..', 'serviceAccountKey.json'));
}

admin.initializeApp({ credential: admin.credential.cert(loadCredential()) });
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

/** Season titles (seasons won per player). Null if never written. */
async function getSeasonTitles() {
  const doc = await db.collection('meta').doc('seasonTitles').get();
  return doc.exists ? doc.data().titles || {} : null;
}

async function setSeasonTitles(titles) {
  await db.collection('meta').doc('seasonTitles').set({ titles });
}

/** After a season rollover, zero the legacy current-season tally. */
async function clearLegacyCurrentSeason() {
  await db.collection('meta').doc('legacyWins').set({ currentSeason: {} }, { merge: true });
}

/** Record a season result (idempotent by year). Returns false if already recorded. */
async function recordSeasonResult(year, winnerIds, counts) {
  const ref = db.collection('seasons').doc(String(year));
  if ((await ref.get()).exists) return false;
  await ref.set({ year, winnerIds, counts, announcedAt: admin.firestore.FieldValue.serverTimestamp() });
  return true;
}

/** Look up a word of the day. Accepts a word string or a puzzle number. */
async function findWord(query) {
  if (/^\d+$/.test(query)) {
    const doc = await db.collection('words').doc(query).get();
    return doc.exists ? doc.data() : null;
  }
  const snap = await db.collection('words')
    .where('word', '==', query.toUpperCase()).limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
}

/** All scores for one puzzle number. */
async function scoresForPuzzle(puzzle) {
  const snap = await db.collection('scores').where('puzzle', '==', puzzle).get();
  return snap.docs.map((d) => d.data());
}

/** Cheap count of a player's games (Firestore count aggregation — no doc reads). */
async function countGames(userId) {
  const agg = await db.collection('scores').where('userId', '==', userId).count().get();
  return agg.data().count;
}

/** Count of a player's aces (score of 1). */
async function countAces(userId) {
  const agg = await db.collection('scores')
    .where('userId', '==', userId).where('score', '==', 1).count().get();
  return agg.data().count;
}

/** Store a word of the day (idempotent by puzzle number). */
async function saveWord(puzzle, word, date) {
  await db.collection('words').doc(String(puzzle)).set({ puzzle, word, date });
}

/** Highest puzzle number that has a stored word (or null if none). */
async function latestWordPuzzle() {
  const snap = await db.collection('words').orderBy('puzzle', 'desc').limit(1).get();
  return snap.empty ? null : snap.docs[0].data().puzzle;
}

module.exports = {
  saveScore, scoresForWeek, scoresForMonth, allScores,
  scoresForPlayer, recordWeekResult, weekAlreadyAnnounced, weeklyWinCounts,
  weeklyWinCountsSince, getTheme, setTheme, currentChampionId,
  getSeasonTitles, setSeasonTitles, clearLegacyCurrentSeason, recordSeasonResult,
  findWord, scoresForPuzzle, countGames, countAces, saveWord, latestWordPuzzle,
};
