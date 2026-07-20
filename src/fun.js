/**
 * Data crunching for the fun commands: /versus, /roast, /fortune.
 * All functions take raw score-doc arrays (already fetched) — no db calls here.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WORDLE_EPOCH_UTC = Date.UTC(2021, 5, 19);
const puzzleWeekday = (p) => new Date(WORDLE_EPOCH_UTC + p * 86_400_000).getUTCDay();

/** Basic per-player aggregates from their score docs. */
function playerStats(scores) {
  const s = {
    games: scores.length, fails: 0, total: 0, aces: 0, twos: 0, sixes: 0,
    byWeekday: Array.from({ length: 7 }, () => ({ n: 0, sum: 0 })),
    byMonth: {},
  };
  for (const d of scores) {
    s.total += d.score;
    if (d.failed) s.fails++;
    if (d.score === 1) s.aces++;
    if (d.score === 2) s.twos++;
    if (d.score === 6) s.sixes++;
    const wd = puzzleWeekday(d.puzzle);
    s.byWeekday[wd].n++; s.byWeekday[wd].sum += d.score;
    const m = (s.byMonth[d.monthId] ||= { n: 0, sum: 0 });
    m.n++; m.sum += d.score;
  }
  s.avg = s.games ? s.total / s.games : null;
  return s;
}

function worstWeekday(stats) {
  let worst = null;
  stats.byWeekday.forEach((d, i) => {
    if (d.n >= 10) {
      const avg = d.sum / d.n;
      if (!worst || avg > worst.avg) worst = { day: DAY_NAMES[i], avg };
    }
  });
  return worst;
}

function bestWeekday(stats) {
  let best = null;
  stats.byWeekday.forEach((d, i) => {
    if (d.n >= 10) {
      const avg = d.sum / d.n;
      if (!best || avg < best.avg) best = { day: DAY_NAMES[i], avg };
    }
  });
  return best;
}

function worstMonth(stats) {
  let worst = null;
  for (const [m, v] of Object.entries(stats.byMonth)) {
    if (v.n >= 15) {
      const avg = v.sum / v.n;
      if (!worst || avg > worst.avg) worst = { month: m, avg };
    }
  }
  return worst;
}

/** Head-to-head between two players' score arrays. */
function versus(aScores, bScores) {
  const aBy = new Map(aScores.map((s) => [s.puzzle, s]));
  const r = { shared: 0, aWins: 0, bWins: 0, ties: 0, aSum: 0, bSum: 0,
              weeks: {}, aWeekWins: 0, bWeekWins: 0, weekTies: 0 };
  for (const b of bScores) {
    const a = aBy.get(b.puzzle);
    if (!a) continue;
    r.shared++; r.aSum += a.score; r.bSum += b.score;
    if (a.score < b.score) r.aWins++;
    else if (b.score < a.score) r.bWins++;
    else r.ties++;
    const w = (r.weeks[b.weekId] ||= { a: 0, b: 0 });
    w.a += a.score; w.b += b.score;
  }
  for (const w of Object.values(r.weeks)) {
    if (w.a < w.b) r.aWeekWins++;
    else if (w.b < w.a) r.bWeekWins++;
    else r.weekTies++;
  }
  r.sharedWeeks = Object.keys(r.weeks).length;
  return r;
}

/** Deterministic per-day random pick so /fortune stays stable all day. */
function dailyPick(arr, userId, dateStr) {
  let h = 0;
  const s = userId + dateStr;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

/** Build roast lines from a player's stats; returns applicable ones. */
function roastLines(name, stats) {
  const lines = [];
  const ww = worstWeekday(stats), wm = worstMonth(stats);
  if (stats.fails >= 5) lines.push(
    `${name} has failed the Wordle ${stats.fails} times. The dictionary has filed a restraining order.`);
  if (ww) lines.push(
    `${name}'s ${ww.day} average is ${ww.avg.toFixed(2)}. Maybe just stay in bed on ${ww.day}s.`);
  if (wm) lines.push(
    `${wm.month} was ${name}'s villain era: a ${wm.avg.toFixed(2)} average. We don't talk about ${wm.month}.`);
  if (stats.sixes >= 10) lines.push(
    `${name} has clawed out ${stats.sixes} wins on the very last guess. Living life one heart attack at a time.`);
  if (stats.aces === 0 && stats.games >= 100) lines.push(
    `${stats.games} games and ${name} has never once guessed it first try. Consistency is a virtue, I guess.`);
  if (stats.avg && stats.avg > 4.3) lines.push(
    `${name}'s lifetime average is ${stats.avg.toFixed(2)}. The word "SKILL" has 5 letters — try guessing it sometime.`);
  if (stats.avg && stats.avg <= 4.0 && stats.fails >= 3) lines.push(
    `${name} averages a shiny ${stats.avg.toFixed(2)} but still has ${stats.fails} Xs. Even the sun has spots.`);
  if (!lines.length) lines.push(
    `${name}'s stats are honestly too clean to roast. That's the most suspicious thing about them. 🤨`);
  return lines;
}

/** Build fortune lines for the current day. */
function fortuneLines(name, stats, todayWeekdayIdx) {
  const wd = stats.byWeekday[todayWeekdayIdx];
  const todayAvg = wd.n >= 5 ? wd.sum / wd.n : null;
  const best = bestWeekday(stats);
  const lines = [];
  if (todayAvg != null) {
    if (best && DAY_NAMES[todayWeekdayIdx] === best.day) {
      lines.push(`⭐ Today is ${best.day} — historically your BEST day (${todayAvg.toFixed(2)} avg). The tiles align in your favor.`);
    } else if (todayAvg <= (stats.avg ?? 4)) {
      lines.push(`🔮 Your ${DAY_NAMES[todayWeekdayIdx]} average is ${todayAvg.toFixed(2)}, better than your usual. Fortune smiles — open the app with confidence.`);
    } else {
      lines.push(`⚠️ ${DAY_NAMES[todayWeekdayIdx]}s have not been kind to you (${todayAvg.toFixed(2)} avg). Tread carefully. Start with a safe word.`);
    }
  }
  lines.push(`🎲 The spirits suggest a vowel-heavy opener today.`);
  lines.push(`🍀 A green tile in position 3 will change your destiny this week.`);
  lines.push(`🧘 Breathe before guess four. Your future self thanks you.`);
  lines.push(`📜 An ancient proverb: the player who spoils the word shall know eternal shame.`);
  return lines;
}

module.exports = {
  playerStats, versus, roastLines, fortuneLines, dailyPick,
  worstWeekday, bestWeekday, worstMonth, DAY_NAMES,
};
