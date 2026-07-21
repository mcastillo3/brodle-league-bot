/**
 * One-time fixup: scores that were saved under a raw Discord id BEFORE the
 * identity map existed get re-keyed to the player's canonical legacy id, so
 * they merge into the right column.
 *
 * Safe to re-run. Only moves docs whose userId is a key in IDENTITY below.
 * On a clash (a legacy doc already exists for that puzzle), the lower score
 * is kept — same rule as the player merge.
 *
 * Usage:
 *   node fix_live_ids.js            (dry run)
 *   node fix_live_ids.js --commit   (apply)
 */

const admin = require('firebase-admin');

// Must match the IDENTITY map in src/index.js.
const IDENTITY = {
  '462970375589068800': 'legacy_MC', // Manny
  '444869278160650280': 'legacy_DL', // Daniel L
  '1514100951508844655': 'legacy_BG', // Ben
  "970710353132548096": "legacy_PT", // Pete
  "1334729598302421124": "legacy_DH", // Daniel H
};

const COMMIT = process.argv.includes('--commit');
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
const db = admin.firestore();

async function main() {
  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);
  const ops = [];
  let moved = 0, keptExisting = 0;

  for (const [discordId, legacyId] of Object.entries(IDENTITY)) {
    const snap = await db.collection('scores').where('userId', '==', discordId).get();
    if (snap.empty) continue;
    console.log(`${discordId} -> ${legacyId}: ${snap.size} live doc(s)`);

    for (const doc of snap.docs) {
      const s = doc.data();
      const targetRef = db.collection('scores').doc(`${s.puzzle}_${legacyId}`);
      const existing = await targetRef.get();

      if (existing.exists && existing.data().score <= s.score) {
        keptExisting++;               // legacy already has an equal/better score
      } else {
        ops.push({ type: 'set', ref: targetRef, data: { ...s, userId: legacyId } });
        moved++;
      }
      ops.push({ type: 'delete', ref: doc.ref });
    }
  }

  console.log(`\nWould move ${moved} doc(s), keep ${keptExisting} existing, delete the old raw-id docs.`);
  if (!COMMIT) { console.log('\nDry run only. Re-run with --commit to apply.'); return; }

  for (let i = 0; i < ops.length; i += 450) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + 450)) {
      if (op.type === 'set') batch.set(op.ref, op.data);
      else batch.delete(op.ref);
    }
    await batch.commit();
  }
  console.log('Done. Re-run /alltime to confirm the columns merged.');
}

main().catch((e) => { console.error(e); process.exit(1); });
