/**
 * Fix the all-time weekly-win tallies in meta/legacyWins.
 *
 * The original seed read only the LAST tally row from the spreadsheet, but that
 * row had silently dropped players (JG, BM) who earned wins earlier and stopped
 * appearing. This rebuilds the tally from each player's PEAK recorded value
 * across all sheets — recovering JG's 11, BM's 3, and correcting CA (31->32).
 *
 * Only touches the `alltime` map. Bot-era wins (in the `weeks` collection) are
 * added on top by weeklyWinCounts() and are unaffected.
 *
 * Usage:
 *   node fix_alltime_wins.js            (dry run — shows current vs corrected)
 *   node fix_alltime_wins.js --commit   (write)
 */

const admin = require('firebase-admin');

// Corrected values, from each player's peak all-time count in the spreadsheet
// (SA already merged into CA). Edit here if you know additional corrections.
const CORRECTED_ALLTIME = {
  legacy_BG: 44,
  legacy_MC: 43,
  legacy_CA: 32,
  legacy_DH: 12,
  legacy_JG: 11,
  legacy_BM: 3,
};

const COMMIT = process.argv.includes('--commit');
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
const db = admin.firestore();

async function main() {
  const ref = db.collection('meta').doc('legacyWins');
  const doc = await ref.get();
  const current = doc.exists ? (doc.data().alltime || {}) : {};

  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);
  console.log('Player        current -> corrected');
  const all = new Set([...Object.keys(current), ...Object.keys(CORRECTED_ALLTIME)]);
  for (const id of [...all].sort()) {
    const cur = current[id] ?? 0;
    const fix = CORRECTED_ALLTIME[id] ?? cur; // don't wipe anything unexpected
    const mark = cur !== fix ? '  <-- changed' : '';
    console.log(`  ${id.padEnd(12)} ${String(cur).padStart(3)} -> ${String(fix).padStart(3)}${mark}`);
  }

  if (!COMMIT) {
    console.log('\nDry run only. Re-run with --commit to write.');
    return;
  }

  // Merge corrected values over whatever exists, preserving any keys we don't manage.
  const merged = { ...current, ...CORRECTED_ALLTIME };
  await ref.set({ alltime: merged }, { merge: true });
  console.log('\nWrote corrected all-time tallies. Run /alltime to confirm.');
}

main().catch((e) => { console.error(e); process.exit(1); });
