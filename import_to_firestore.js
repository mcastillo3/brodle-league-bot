/**
 * Import wordle_history.json into Firestore.
 *
 * Setup:
 *   1. npm install firebase-admin
 *   2. Download a service account key from Firebase Console:
 *      Project Settings -> Service accounts -> Generate new private key
 *      Save it next to this script as serviceAccountKey.json
 *   3. node import_to_firestore.js            (dry run — prints what it would write)
 *      node import_to_firestore.js --commit   (actually writes)
 *      node import_to_firestore.js --commit --daily   (also writes flat dailyScores docs)
 *
 * Schema written:
 *   wordleHistory/{weekId}          one doc per tab (160 docs) — everything embedded
 *   wordlePlayers/{playerId}        one doc per player with career aggregates
 *   wordleDailyScores/{num_player}  OPTIONAL flat collection (~4,600 docs) for
 *                                   per-puzzle queries, only with --daily
 *
 * Rename the collection constants below to match your existing app's schema.
 */

const fs = require('fs');
const admin = require('firebase-admin');

// ---- CONFIG ----------------------------------------------------------------
const WEEKS_COLLECTION = 'wordleHistory';
const PLAYERS_COLLECTION = 'wordlePlayers';
const DAILY_COLLECTION = 'wordleDailyScores';
const JSON_PATH = './wordle_history.json';
// ----------------------------------------------------------------------------

const COMMIT = process.argv.includes('--commit');
const DAILY = process.argv.includes('--daily');

if (COMMIT) {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = COMMIT ? admin.firestore() : null;

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

async function commitInChunks(writes) {
  // Firestore batches max out at 500 ops
  for (let i = 0; i < writes.length; i += 450) {
    const batch = db.batch();
    for (const { ref, data } of writes.slice(i, i + 450)) batch.set(ref, data);
    await batch.commit();
    console.log(`  committed ${Math.min(i + 450, writes.length)}/${writes.length}`);
  }
}

async function main() {
  const { weeks } = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  console.log(`${weeks.length} weeks loaded from JSON. Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}`);

  const weekWrites = [];
  const dailyWrites = [];
  const career = {}; // playerId -> aggregates

  for (const w of weeks) {
    const weekId = slug(w.sheet); // e.g. "week_146", "piss_13", "week_of_94"
    const doc = {
      sheet: w.sheet,
      order: w.sheet_index,          // preserves chronological tab order
      game: w.game,                  // "main" | "piss"
      format: w.format,              // "day" | "wordle_num"
      players: w.players,
      days: w.days,                  // [{day|wordle_number, word?, scores:{BG:4,...}}]
      points: w.week_points,
      avg: w.week_avg,
      daysPlayed: w.days_played,
      season: w.season,
      seasonWins: w.season_wins,
      seasonLabel: w.season_label,
      allTimeWins: w.alltime_wins,
      importedAt: new Date().toISOString(),
      source: 'excel_import_v1',
    };
    weekWrites.push({ path: `${WEEKS_COLLECTION}/${weekId}`, data: doc });

    for (const d of w.days) {
      for (const [p, score] of Object.entries(d.scores)) {
        if (w.game === 'main') {
          const c = (career[p] ||= { games: 0, totalGuesses: 0, dist: {} });
          c.games += 1;
          c.totalGuesses += score;
          c.dist[score] = (c.dist[score] || 0) + 1;
        }
        if (DAILY && d.wordle_number) {
          dailyWrites.push({
            path: `${DAILY_COLLECTION}/${w.game}_${d.wordle_number}_${p}`,
            data: {
              game: w.game,
              wordleNumber: d.wordle_number,
              word: d.word || null,
              player: p,
              score,
              weekId,
            },
          });
        }
      }
    }
  }

  const playerWrites = Object.entries(career).map(([p, c]) => ({
    path: `${PLAYERS_COLLECTION}/${p}`,
    data: {
      id: p,
      gamesPlayed: c.games,
      totalGuesses: c.totalGuesses,
      average: +(c.totalGuesses / c.games).toFixed(4),
      guessDistribution: c.dist,
      source: 'excel_import_v1',
    },
  }));

  console.log(`Would write: ${weekWrites.length} week docs, ${playerWrites.length} player docs` +
    (DAILY ? `, ${dailyWrites.length} daily score docs` : ' (no daily docs; add --daily)'));

  if (!COMMIT) {
    console.log('\nSample week doc:', JSON.stringify(weekWrites[0].data, null, 2).slice(0, 800));
    console.log('\nSample player doc:', JSON.stringify(playerWrites[0].data, null, 2));
    console.log('\nDry run only. Re-run with --commit to write.');
    return;
  }

  const toRefs = (arr) => arr.map(({ path, data }) => ({ ref: db.doc(path), data }));
  await commitInChunks(toRefs(weekWrites));
  await commitInChunks(toRefs(playerWrites));
  if (DAILY) await commitInChunks(toRefs(dailyWrites));
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
