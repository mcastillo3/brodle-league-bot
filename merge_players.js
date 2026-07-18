/**
 * Merge one player's history into another (same person, two sets of initials).
 *
 * Re-keys every score doc from FROM_ID to TO_ID. Score docs are keyed
 * `{puzzle}_{userId}`, so this copies to the new key and deletes the old one.
 * On any puzzle where BOTH ids have a score, the LOWER (better) score is kept.
 * Weekly-title tallies in meta/legacyWins and in bot-era `weeks` docs are also
 * moved from FROM_ID to TO_ID so no wins are lost.
 *
 * Usage:
 *   node merge_players.js            (dry run — reports exactly what would change)
 *   node merge_players.js --commit   (apply)
 */

const admin = require('firebase-admin');

// ---- CONFIG ----------------------------------------------------------------
const FROM_ID = 'legacy_SA';   // absorbed and removed
const TO_ID   = 'legacy_CA';   // survivor
const TO_NAME = 'CA';          // username written onto merged docs
// ----------------------------------------------------------------------------

const COMMIT = process.argv.includes('--commit');

admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
const db = admin.firestore();

async function main() {
  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}`);
  console.log(`Merging ${FROM_ID} -> ${TO_ID}\n`);

  // --- 1. Gather both players' score docs -----------------------------------
  const [fromSnap, toSnap] = await Promise.all([
    db.collection('scores').where('userId', '==', FROM_ID).get(),
    db.collection('scores').where('userId', '==', TO_ID).get(),
  ]);

  const toByPuzzle = {};
  toSnap.forEach((d) => { toByPuzzle[d.data().puzzle] = d.data(); });

  const ops = [];       // {type, ref, data?}
  let moved = 0, mergedLower = 0, keptExisting = 0;

  for (const doc of fromSnap.docs) {
    const s = doc.data();
    const existing = toByPuzzle[s.puzzle];
    const targetRef = db.collection('scores').doc(`${s.puzzle}_${TO_ID}`);

    if (!existing) {
      // no clash: re-key straight over
      ops.push({ type: 'set', ref: targetRef,
        data: { ...s, userId: TO_ID, username: TO_NAME } });
      moved++;
    } else {
      // clash: keep the lower score
      const winner = s.score <= existing.score ? s : existing;
      if (winner === s) {
        ops.push({ type: 'set', ref: targetRef,
          data: { ...s, userId: TO_ID, username: TO_NAME } });
        mergedLower++;
      } else {
        keptExisting++; // existing CA score already lower; leave it
      }
    }
    // remove the old SA-keyed doc either way
    ops.push({ type: 'delete', ref: doc.ref });
  }

  console.log(`Score docs under ${FROM_ID}: ${fromSnap.size}`);
  console.log(`  moved with no clash:        ${moved}`);
  console.log(`  clash, SA lower (replaced): ${mergedLower}`);
  console.log(`  clash, CA already lower:    ${keptExisting}`);
  console.log(`  old ${FROM_ID} docs deleted:  ${fromSnap.size}`);

  // --- 2. Win tallies in meta/legacyWins ------------------------------------
  const legacyRef = db.collection('meta').doc('legacyWins');
  const legacyDoc = await legacyRef.get();
  let legacyChange = null;
  if (legacyDoc.exists) {
    const L = legacyDoc.data();
    const fold = (obj) => {
      if (!obj) return obj;
      if (obj[FROM_ID]) {
        obj[TO_ID] = (obj[TO_ID] || 0) + obj[FROM_ID];
        delete obj[FROM_ID];
      }
      return obj;
    };
    legacyChange = {
      alltime: fold({ ...(L.alltime || {}) }),
      currentSeason: fold({ ...(L.currentSeason || {}) }),
      seasonLabel: L.seasonLabel ?? null,
    };
    console.log(`\nmeta/legacyWins after merge:`);
    console.log('  all-time:', legacyChange.alltime);
    console.log('  current season:', legacyChange.currentSeason);
  }

  // --- 3. Bot-era weekly wins (weeks/*.winnerIds) ---------------------------
  const weeksSnap = await db.collection('weeks').get();
  const weekFixes = [];
  weeksSnap.forEach((d) => {
    const ids = d.data().winnerIds || [];
    if (ids.includes(FROM_ID)) {
      const next = [...new Set(ids.map((x) => (x === FROM_ID ? TO_ID : x)))];
      weekFixes.push({ ref: d.ref, winnerIds: next });
    }
  });
  if (weekFixes.length) console.log(`\nweeks docs with ${FROM_ID} as winner to re-tag: ${weekFixes.length}`);

  if (!COMMIT) {
    console.log('\nDry run only. Re-run with --commit to apply.');
    return;
  }

  // --- Apply -----------------------------------------------------------------
  for (let i = 0; i < ops.length; i += 450) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + 450)) {
      if (op.type === 'set') batch.set(op.ref, op.data);
      else batch.delete(op.ref);
    }
    await batch.commit();
    console.log(`  score ops ${Math.min(i + 450, ops.length)}/${ops.length}`);
  }
  if (legacyChange) await legacyRef.set(legacyChange);
  for (const wf of weekFixes) await wf.ref.update({ winnerIds: wf.winnerIds });

  console.log('\nMerge complete.');
  console.log(`Remember: remove SA from PLAYER_MAP/NAME_MAP, and point any`);
  console.log(`"legacy_SA" name entry at ${TO_NAME} is no longer needed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
