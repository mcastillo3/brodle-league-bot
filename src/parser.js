/**
 * Parses NYT Wordle share snippets and maps puzzle numbers to calendar dates.
 *
 * A share snippet's first line looks like:
 *   Wordle 1,854 3/6        (comma appears once numbers passed 999)
 *   Wordle 1854 X/6         (X = failed)
 *   Wordle 1,854 4/6*       (asterisk = hard mode)
 */

const FAIL_SCORE = parseInt(process.env.FAIL_SCORE || '7', 10);

// Wordle #0 ("CIGAR") was published 2021-06-19. Puzzle date = epoch + puzzle number.
const WORDLE_EPOCH_UTC = Date.UTC(2021, 5, 19); // June 19, 2021
const MS_PER_DAY = 86_400_000;

const SHARE_REGEX = /wordle\s+([\d,]+)\s+([1-6xX])\/6(\*?)/i;

/** Parse a message. Returns null if it isn't a Wordle share. */
function parseWordleShare(content) {
  const match = content.match(SHARE_REGEX);
  if (!match) return null;

  const puzzle = parseInt(match[1].replace(/,/g, ''), 10);
  if (!Number.isFinite(puzzle) || puzzle < 1 || puzzle > 20000) return null;

  const failed = match[2].toLowerCase() === 'x';
  return {
    puzzle,
    score: failed ? FAIL_SCORE : parseInt(match[2], 10),
    failed,
    hardMode: match[3] === '*',
  };
}

/** UTC Date (midnight) on which a puzzle number was published. */
function puzzleDate(puzzle) {
  return new Date(WORDLE_EPOCH_UTC + puzzle * MS_PER_DAY);
}

/** Today's puzzle number in the given IANA timezone. */
function currentPuzzleNumber(timezone) {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const localMidnightUTC = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
  return Math.round((localMidnightUTC - WORDLE_EPOCH_UTC) / MS_PER_DAY);
}

/**
 * League week runs Monday..Sunday, keyed by the Monday's ISO date.
 * Derived from the PUZZLE's date, not the post time — so a score posted
 * late Sunday night or 2 AM Monday still lands in the correct week.
 */
function weekIdForPuzzle(puzzle) {
  const d = puzzleDate(puzzle);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const monday = new Date(d.getTime() - daysSinceMonday * MS_PER_DAY);
  return monday.toISOString().slice(0, 10); // "2026-07-13"
}

/** All 7 puzzle numbers belonging to the same league week as `puzzle`. */
function puzzlesInWeek(puzzle) {
  const d = puzzleDate(puzzle);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const mondayPuzzle = puzzle - daysSinceMonday;
  return Array.from({ length: 7 }, (_, i) => mondayPuzzle + i);
}

/** "2026-07" month bucket for a puzzle. */
function monthIdForPuzzle(puzzle) {
  return puzzleDate(puzzle).toISOString().slice(0, 7);
}

module.exports = {
  parseWordleShare,
  puzzleDate,
  currentPuzzleNumber,
  weekIdForPuzzle,
  puzzlesInWeek,
  monthIdForPuzzle,
};
