/**
 * Cleanup for score docs that were written under a CORRUPTED userId.
 *
 * Background: a Discord ID pasted into a script WITHOUT quotes is parsed as a
 * JavaScript number, which can't hold 18-19 digits exactly, so its low digits
 * get rounded (e.g. ...421124 -> ...421200). Backfilled docs then carry the
 * rounded ID, and NAME_MAP (keyed by the real ID) never matches them.
 *
 * This script finds every backfill-sourced score doc whose userId is NOT one of
 * the correct IDs you expect, shows them grouped, and (with --commit) deletes
 * them. Then re-run the corrected backfill_scores.js to rewrite them properly.
 *
 * It ONLY ever deletes docs where source == 'spreadsheet_backfill', so live
 * scores captured by the bot are never touched.
 *
 * Usage:
 *   1. In VALID_IDS below, list every userId you consider correct — the real
 *      (quoted!) Discord IDs AND the legacy_XX keys you expect to keep.
 *   2. node cleanup_bad_ids.js            (dry run — lists what it would delete)
 *      node cleanup_bad_ids.js --commit   (delete them)
 */

const admin = require('firebase-admin');

// ---- CONFIG ----------------------------------------------------------------
// Every userId that is CORRECT and should be kept. Anything else that came from
// the backfill is treated as corrupted and removed. Quote every ID.
const VALID_IDS = new Set([
  // real Discord IDs (must be quoted strings):
  '1514100951508844655', // Ben  -- re-verify this one from Discord
  '462970375589068800',  // Manny
  '444869278160650280',  // Daniel L
  '1334729598302421124', // Daniel H  <- correct value; the ...200 doc is the bad one
  // legacy keys kept for players with no live Discord posts:
  'legacy_BG', 'legacy_MC', 'legacy_CA', 'legacy_DH', 'legacy_JG',
  'legacy_SA', 'legacy_BM', 'legacy_TB', 'legacy_DL', 'legacy_PT', 'legacy_NP',
]);
// ----------------------------------------------------------------------------

const COMMIT = process.argv.includes('--commit');

admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
const db = admin.firestore();

async function main() {
  const snap = await db.collection('scores')
    .where('source', '==', 'spreadsheet_backfill').get();

  const bad = [];
  const byBadId = {};
  snap.forEach((doc) => {
    const d = doc.data();
    if (!VALID_IDS.has(d.userId)) {
      bad.push(doc.ref);
      (byBadId[`${d.userId} (${d.username})`] ||= []).push(d.puzzle);
    }
  });

  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}`);
  console.log(`Scanned ${snap.size} backfill docs. Found ${bad.length} with an unexpected userId:\n`);
  for (const [key, puzzles] of Object.entries(byBadId)) {
    console.log(`  ${key}: ${puzzles.length} docs (puzzles ${Math.min(...puzzles)}..${Math.max(...puzzles)})`);
  }
  if (!bad.length) {
    console.log('\nNothing to delete. Every backfill doc has a valid userId.');
    return;
  }

  if (!COMMIT) {
    console.log('\nDry run only. If the list above is what you expect to remove,');
    console.log('re-run with --commit, then re-run the corrected backfill_scores.js.');
    return;
  }

  for (let i = 0; i < bad.length; i += 450) {
    const batch = db.batch();
    for (const ref of bad.slice(i, i + 450)) batch.delete(ref);
    await batch.commit();
    console.log(`  deleted ${Math.min(i + 450, bad.length)}/${bad.length}`);
  }
  console.log('Done. Now re-run: node backfill_scores.js --commit');
}

main().catch((e) => { console.error(e); process.exit(1); });
