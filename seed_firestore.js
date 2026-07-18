/**
 * Seed a FRESH Firestore database from firestore_seed.json in one efficient pass.
 *
 * Writes:
 *   scores/{puzzle}_{userId}   every historical score (SA already merged into CA)
 *   players/{userId}           career aggregates
 *   meta/legacyWins            spreadsheet-era win tallies
 *
 * Uses BulkWriter (higher throughput, auto-retries) and writes in the most
 * quota-efficient way: one write per doc, no reads. Total writes ≈ scores +
 * players + 1, well under the 20k/day free-tier cap for this dataset.
 *
 * Setup:
 *   - Point serviceAccountKey.json at the NEW project.
 *   - node seed_firestore.js            (dry run — counts only)
 *     node seed_firestore.js --commit   (write)
 */

const fs = require('fs');

const COMMIT = process.argv.includes('--commit');
const seed = JSON.parse(fs.readFileSync('./firestore_seed.json', 'utf8'));

console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}`);
console.log(`  scores:  ${seed.scores.length}`);
console.log(`  players: ${seed.players.length}`);
console.log(`  meta/legacyWins: 1`);
const totalWrites = seed.scores.length + seed.players.length + 1;
console.log(`  total writes: ${totalWrites} (free-tier daily cap is 20000)`);

if (!COMMIT) {
  console.log('\nSample score doc:', JSON.stringify(seed.scores[0]));
  console.log('Sample player doc:', JSON.stringify(seed.players[0]));
  console.log('\nDry run only. Point serviceAccountKey.json at the NEW project,');
  console.log('then re-run with --commit.');
  process.exit(0);
}

const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
const db = admin.firestore();

(async () => {
  const writer = db.bulkWriter();
  let done = 0;
  const tick = () => { if (++done % 500 === 0) console.log(`  ${done}/${totalWrites}`); };

  for (const s of seed.scores) {
    writer.set(db.collection('scores').doc(`${s.puzzle}_${s.userId}`), s).then(tick);
  }
  for (const p of seed.players) {
    writer.set(db.collection('players').doc(p.id), p).then(tick);
  }
  writer.set(db.collection('meta').doc('legacyWins'), seed.meta_legacyWins).then(tick);

  await writer.close();
  console.log(`\nDone. Wrote ${totalWrites} documents to the new database.`);
})().catch((e) => { console.error(e); process.exit(1); });
