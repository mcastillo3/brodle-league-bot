/**
 * Turns raw score docs into ranked standings and pretty Discord embeds.
 *
 * Ranking rule (weekly): lowest TOTAL wins. Puzzles a player skipped count as
 * MISSED_SCORE (default 7) so skipping a hard day isn't a free pass. Set
 * MISSED_SCORE=0 in .env to rank by average of played games instead.
 */

const { EmbedBuilder } = require('discord.js');

const MISSED_SCORE = parseInt(process.env.MISSED_SCORE || '7', 10);
const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * @param scores  array of score docs
 * @param puzzleCount  how many puzzles the period contains (7 for a week);
 *                     pass null for month/all-time (no missed-day penalty there)
 */
function computeStandings(scores, puzzleCount = null) {
  const byUser = {};
  for (const s of scores) {
    const u = (byUser[s.userId] ||= {
      userId: s.userId, username: s.username,
      played: 0, rawTotal: 0, fails: 0, dist: {},
    });
    u.username = s.username; // keep freshest name
    u.played += 1;
    u.rawTotal += s.score;
    if (s.failed) u.fails += 1;
    u.dist[s.score] = (u.dist[s.score] || 0) + 1;
  }

  const standings = Object.values(byUser).map((u) => {
    const missed = puzzleCount != null ? Math.max(0, puzzleCount - u.played) : 0;
    const total = u.rawTotal + (MISSED_SCORE > 0 ? missed * MISSED_SCORE : 0);
    const average = u.played ? +(u.rawTotal / u.played).toFixed(3) : null;
    return { ...u, missed, total, average };
  });

  // Weekly with penalty: sort by penalized total. Otherwise: sort by average.
  const usePenalty = puzzleCount != null && MISSED_SCORE > 0;
  standings.sort((a, b) =>
    usePenalty ? a.total - b.total || a.rawTotal - b.rawTotal
               : a.average - b.average || b.played - a.played);
  return standings;
}

function winners(standings) {
  if (!standings.length) return [];
  const usePenalty = standings[0].missed !== undefined && parseInt(process.env.MISSED_SCORE || '7', 10) > 0;
  const bestKey = usePenalty ? 'total' : 'average';
  const best = standings[0][bestKey];
  return standings.filter((s) => s[bestKey] === best);
}

function standingsEmbed(title, standings, { showTotal = true, footer = '' } = {}) {
  const lines = standings.map((s, i) => {
    const rank = MEDALS[i] || ` ${i + 1}.`;
    const bits = [];
    if (showTotal) bits.push(`**${s.total}** pts`);
    bits.push(`avg ${s.average ?? '—'}`);
    bits.push(`${s.played} played`);
    if (s.missed) bits.push(`${s.missed} missed`);
    if (s.fails) bits.push(`${s.fails} ❌`);
    return `${rank} **${s.username}** — ${bits.join(' · ')}`;
  });
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x6aaa64) // wordle green
    .setDescription(lines.join('\n') || '_No scores yet._');
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

function playerStatsEmbed(username, scores, weeklyWins) {
  if (!scores.length) {
    return new EmbedBuilder().setTitle(`${username} — no games on record`).setColor(0x787c7e);
  }
  const played = scores.length;
  const fails = scores.filter((s) => s.failed).length;
  const total = scores.reduce((a, s) => a + s.score, 0);
  const avg = (total / played).toFixed(3);
  const best = Math.min(...scores.map((s) => s.score));

  // guess distribution bar chart (1-6 + X)
  const dist = {};
  for (const s of scores) {
    const key = s.failed ? 'X' : String(s.score);
    dist[key] = (dist[key] || 0) + 1;
  }
  const maxCount = Math.max(...Object.values(dist));
  const rows = ['1', '2', '3', '4', '5', '6', 'X'].map((k) => {
    const n = dist[k] || 0;
    const bar = '🟩'.repeat(Math.max(n ? 1 : 0, Math.round((n / maxCount) * 10)));
    return `\`${k}\` ${bar} ${n}`;
  });

  return new EmbedBuilder()
    .setTitle(`📊 ${username} — all-time stats`)
    .setColor(0xc9b458) // wordle yellow
    .addFields(
      { name: 'Games', value: String(played), inline: true },
      { name: 'Average', value: avg, inline: true },
      { name: 'Best', value: String(best), inline: true },
      { name: 'Fails', value: String(fails), inline: true },
      { name: 'Weekly titles', value: String(weeklyWins), inline: true },
      { name: 'Guess distribution', value: rows.join('\n') },
    );
}

/**
 * Renders the week as a monospace grid that mirrors the league spreadsheet:
 *
 *          BG  MC  CA  DH
 *   1850    4   5   4   5
 *   1851    3   4   ·   4
 *   ...
 *   pts:   24  26  19  27
 *   avg:  4.0 4.3 3.8 4.5
 *
 * @param scores   score docs for the week
 * @param puzzles  the 7 puzzle numbers of the week (only elapsed ones shown)
 * @param maxPuzzle latest published puzzle — rows beyond it are hidden
 * @param initialsFor map userId -> 2-3 char label
 */
function formatWeekGrid(scores, puzzles, maxPuzzle, initialsFor) {
  // stable player order: first appearance this week
  const order = [];
  const byCell = {}; // `${puzzle}_${userId}` -> score doc
  for (const s of scores) {
    if (!order.includes(s.userId)) order.push(s.userId);
    byCell[`${s.puzzle}_${s.userId}`] = s;
  }
  if (!order.length) return '```\nNo scores yet this week.\n```';

  const labels = order.map((id) => initialsFor(id));
  const colW = Math.max(4, ...labels.map((l) => l.length + 1));
  const pad = (v) => String(v).padStart(colW);

  const lines = [];
  lines.push(' '.repeat(6) + labels.map(pad).join(''));

  const totals = Object.fromEntries(order.map((id) => [id, 0]));
  const played = Object.fromEntries(order.map((id) => [id, 0]));

  for (const pz of puzzles) {
    if (pz > maxPuzzle) continue; // don't show future days
    const cells = order.map((id) => {
      const s = byCell[`${pz}_${id}`];
      if (!s) return pad('·');
      totals[id] += s.score;
      played[id] += 1;
      return pad(s.failed ? 'X' : s.score);
    });
    lines.push(String(pz).padEnd(6) + cells.join(''));
  }

  lines.push('');
  lines.push('pts:'.padEnd(6) + order.map((id) => pad(totals[id])).join(''));
  lines.push('avg:'.padEnd(6) + order.map((id) =>
    pad(played[id] ? (totals[id] / played[id]).toFixed(1) : '·')).join(''));

  return '```\n' + lines.join('\n') + '\n```';
}

/** Optional extra rows (season wins / all-time wins), same column alignment. */
function formatTallyRows(order, initialsFor, rows) {
  const labels = order.map((id) => initialsFor(id));
  const colW = Math.max(4, ...labels.map((l) => l.length + 1));
  const pad = (v) => String(v).padStart(colW);
  const lines = rows.map(({ label, values }) =>
    label.padEnd(6) + order.map((id) => pad(values[id] ?? 0)).join(''));
  return lines.join('\n');
}

/**
 * Summary table with players as ROWS (for month / all-time, where days won't fit):
 *
 *         G   pts   avg  X  seas  all
 *   BG  978  3905  3.99  5    12   44
 *   MC  968  3985  4.12  8    16   43
 *
 * @param standings  output of computeStandings (already sorted)
 * @param initialsFor userId -> label
 * @param extraCols  [{header, values: {userId: n}}] appended columns (e.g. wins)
 */
function formatStatsTable(standings, initialsFor, extraCols = []) {
  if (!standings.length) return '```\nNo scores recorded yet.\n```';

  const headers = ['G', 'pts', 'avg', 'X', ...extraCols.map((c) => c.header)];
  const rows = standings.map((s) => {
    const base = [s.played, s.rawTotal, s.average?.toFixed(2) ?? '·', s.fails];
    const extra = extraCols.map((c) => c.values[s.userId] ?? 0);
    return { label: initialsFor(s.userId), cells: [...base, ...extra].map(String) };
  });

  const labelW = Math.max(3, ...rows.map((r) => r.label.length)) + 1;
  const colWs = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r.cells[i].length)) + 2);

  const lines = [];
  lines.push(' '.repeat(labelW) + headers.map((h, i) => h.padStart(colWs[i])).join(''));
  for (const r of rows) {
    lines.push(r.label.padEnd(labelW) + r.cells.map((c, i) => c.padStart(colWs[i])).join(''));
  }
  return '```\n' + lines.join('\n') + '\n```';
}

module.exports = {
  computeStandings, winners, standingsEmbed, playerStatsEmbed,
  formatWeekGrid, formatTallyRows, formatStatsTable,
};
