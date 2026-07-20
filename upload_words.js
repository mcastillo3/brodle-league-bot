/**
 * One-time upload of the historical words-of-the-day into a `words` collection
 * (words/{puzzle} -> { puzzle, word }). Powers the /word command.
 *
 * Put next to serviceAccountKey.json and words_seed.json, then:
 *   node upload_words.js            (dry run)
 *   node upload_words.js --commit   (write ~963 docs)
 */
const fs = require('fs');
const words = JSON.parse(fs.readFileSync('./words_seed.json', 'utf8'));
const COMMIT = process.argv.includes('--commit');

console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${words.length} words to write`);
if (!COMMIT) { console.log('Sample:', words.slice(0, 3)); process.exit(0); }

const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
const db = admin.firestore();

(async () => {
  for (let i = 0; i < words.length; i += 450) {
    const batch = db.batch();
    for (const w of words.slice(i, i + 450)) {
      batch.set(db.collection('words').doc(String(w.puzzle)), w);
    }
    await batch.commit();
    console.log(`  ${Math.min(i + 450, words.length)}/${words.length}`);
  }
  console.log('Done.');
})().catch((e) => { console.error(e); process.exit(1); });
