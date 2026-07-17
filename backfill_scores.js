/**
 * Backfill the Discord bot's `scores` collection from wordle_history.json,
 * and store the spreadsheet's recorded win tallies as `meta/legacyWins`.
 *
 * After running this, /alltime, /month (for covered months), and /player
 * will span the full league history, and the win counts will include the
 * spreadsheet-era titles (BG 44, MC 43, ...) exactly as recorded.
 *
 * Usage:
 *   1. Fill in PLAYER_MAP below with your friends' Discord user IDs
 *      (right-click a member with Developer Mode on -> Copy User ID).
 *      Leave an entry's id as null to import them as "legacy_XX" instead
 *      (their stats appear in tables, but /player @mention won't find them).
 *   2. Put this next to wordle_history.json and serviceAccountKey.json.
 *   3. node backfill_scores.js            (dry run)
 *      node backfill_scores.js --commit   (write)
 */

const fs = require("fs");

// ---- CONFIG ----------------------------------------------------------------
const PLAYER_MAP = {
  BG: { id: "1514100951508844655", name: "BG" }, // e.g. id: '123456789012345678'
  MC: { id: "462970375589068800", name: "MC" },
  CA: { id: null, name: "CA" },
  DH: { id: "1334729598302421124", name: "DH" },
  JG: { id: null, name: "JG" },
  SA: { id: null, name: "SA" },
  BM: { id: null, name: "BM" },
  TB: { id: null, name: "TB" },
  DL: { id: "444869278160650280", name: "DL" },
  PT: { id: null, name: "PT" },
  NP: { id: null, name: "NP" },
};

// Players to exclude entirely (e.g. ['TB'] if those all-7 weeks were placeholders)
const SKIP = [];

// Tab 0 ("week of 94") began Monday Sept 4, 2023 = Wordle #807.
// Day-keyed tabs (0..63) are consecutive weeks from that anchor.
const DAY_ERA_MONDAY_PUZZLE = 807;

const JSON_PATH = "./wordle_history.json";
// ----------------------------------------------------------------------------

const COMMIT = process.argv.includes("--commit");
let db = null;
if (COMMIT) {
  const admin = require("firebase-admin"); // only needed when actually writing
  admin.initializeApp({
    credential: admin.credential.cert(require("./serviceAccountKey.json")),
  });
  db = admin.firestore();
}

const WORDLE_EPOCH_UTC = Date.UTC(2021, 5, 19);
const MS_PER_DAY = 86_400_000;
const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const puzzleDate = (p) => new Date(WORDLE_EPOCH_UTC + p * MS_PER_DAY);
const weekIdForPuzzle = (p) => {
  const d = puzzleDate(p);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * MS_PER_DAY);
  return monday.toISOString().slice(0, 10);
};
const monthIdForPuzzle = (p) => puzzleDate(p).toISOString().slice(0, 7);

function resolvePlayer(initials) {
  const m = PLAYER_MAP[initials] || {};
  return { userId: m.id || `legacy_${initials}`, username: m.name || initials };
}

async function main() {
  const { weeks } = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  weeks.sort((a, b) => a.sheet_index - b.sheet_index);

  const writes = new Map(); // docId -> data (map dedupes duplicate-week tabs; later tab wins)
  let skippedScores = 0;

  for (const w of weeks) {
    for (let i = 0; i < w.days.length; i++) {
      const day = w.days[i];
      // puzzle number: real for numbered era; derived from anchor for day era
      let puzzle;
      if (day.wordle_number) {
        puzzle = day.wordle_number;
      } else {
        const offset = day.day ? DAY_ORDER.indexOf(day.day) : i;
        puzzle =
          DAY_ERA_MONDAY_PUZZLE + w.sheet_index * 7 + Math.max(0, offset);
      }
      for (const [initials, score] of Object.entries(day.scores)) {
        if (SKIP.includes(initials)) {
          skippedScores++;
          continue;
        }
        const { userId, username } = resolvePlayer(initials);
        writes.set(`${puzzle}_${userId}`, {
          userId,
          username,
          puzzle,
          score: Math.round(score),
          failed: score >= 7,
          hardMode: false,
          weekId: weekIdForPuzzle(puzzle),
          monthId: monthIdForPuzzle(puzzle),
          source: "spreadsheet_backfill",
        });
      }
    }
  }

  // Legacy win tallies: take the LAST sheet that has recorded all-time wins.
  const lastTally = [...weeks]
    .reverse()
    .find((w) => Object.keys(w.alltime_wins || {}).length);
  const legacy = {
    alltime: {},
    currentSeason: {},
    seasonLabel: lastTally?.season_label || null,
  };
  if (lastTally) {
    for (const [initials, n] of Object.entries(lastTally.alltime_wins)) {
      if (SKIP.includes(initials) || !n) continue;
      legacy.alltime[resolvePlayer(initials).userId] = n;
    }
    for (const [initials, n] of Object.entries(lastTally.season_wins || {})) {
      if (SKIP.includes(initials) || !n) continue;
      legacy.currentSeason[resolvePlayer(initials).userId] = n;
    }
  }

  console.log(`Mode: ${COMMIT ? "COMMIT" : "DRY RUN"}`);
  console.log(
    `Score docs to write: ${writes.size}` +
      (skippedScores ? ` (${skippedScores} skipped)` : ""),
  );
  console.log(`Legacy tallies from "${lastTally?.sheet}":`);
  console.log("  all-time:", legacy.alltime);
  console.log("  current season:", legacy.currentSeason);
  const unmapped = Object.entries(PLAYER_MAP)
    .filter(([, v]) => !v.id)
    .map(([k]) => k);
  if (unmapped.length) {
    console.log(
      `\n⚠️  No Discord ID for: ${unmapped.join(
        ", ",
      )} — they'll be imported as legacy_XX.`,
    );
    console.log(
      "   Fill PLAYER_MAP and re-run (safe to re-run; doc IDs are stable).",
    );
  }

  if (!COMMIT) {
    console.log("\nDry run only. Re-run with --commit to write.");
    return;
  }

  const entries = [...writes.entries()];
  for (let i = 0; i < entries.length; i += 450) {
    const batch = db.batch();
    for (const [id, data] of entries.slice(i, i + 450)) {
      batch.set(db.collection("scores").doc(id), data);
    }
    await batch.commit();
    console.log(
      `  committed ${Math.min(i + 450, entries.length)}/${entries.length}`,
    );
  }
  await db.collection("meta").doc("legacyWins").set(legacy);
  console.log("Legacy wins doc written. Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
