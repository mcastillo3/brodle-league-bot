require('dotenv').config();
const { Client, GatewayIntentBits, Events, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const cron = require('node-cron');

const {
  parseWordleShare, currentPuzzleNumber, weekIdForPuzzle,
  puzzlesInWeek, monthIdForPuzzle,
} = require('./parser');
const db = require('./db');
const {
  computeStandings, winners, standingsEmbed, playerStatsEmbed,
  formatWeekGrid, formatTallyRows, formatStatsTable,
} = require('./leaderboard');
const { renderWeekTable, renderStatsTable } = require('./imageTable');
const themeLib = require('./theme');
const fun = require('./fun');
const ai = require('./ai');

// League rules shown in the /week footer. Edit these lines freely.
const RULES = [
  '1) PLAY W HONOR   ✔️',
  '2) NO CHEATING    ✔️',
  '3) NO SPOILING    ✔️',
  '4) HAVE FUN       ✔️',
];
const WEEK_TITLE = 'NEW NEW BRODLE ORDER';
const WEEK_SUBTITLE = 'shall play 20 years w/ honor & harmonious';

// Seed for seasons won (a season = a calendar year). Used only until the first
// automated rollover writes meta/seasonTitles to Firestore; after that the
// database is the source of truth and this map is ignored.
const SEASON_TITLES_SEED = {
  legacy_BG: 1,
  legacy_CA: 1,
  legacy_MC: 1,
};

const TZ = process.env.TIMEZONE || 'America/Chicago';

// Identity map: real Discord user id -> canonical player id (their legacy_XX).
// When a mapped player posts a live score, it saves under their legacy id so it
// merges with their spreadsheet history instead of creating a separate column.
// SEED maps — the starting point. Live links set via /link are loaded from
// Firestore at startup into LINKS and take precedence, so you never have to
// edit code + redeploy to add a player again.
const IDENTITY_SEED = {
  '462970375589068800': 'legacy_MC',   // MC
  '444869278160650280': 'legacy_DL',   // DL
  '1514100951508844655': 'legacy_BG',  // BG
};
const LABELS_SEED = {
  legacy_BG: 'BG', legacy_MC: 'MC', legacy_DH: 'DH', legacy_DL: 'DL',
  legacy_CA: 'CA', legacy_PT: 'PT', legacy_JG: 'JG', legacy_TB: 'TB',
  legacy_BM: 'BM', legacy_NP: 'NP',
};

// Full display names for prose contexts (roast, fortune) where initials read
// awkwardly. Keyed by canonical id. Falls back to the initials label if a
// player isn't listed here, so it's safe to fill in gradually.
const NAMES = {
  legacy_BG: 'Ben',
  legacy_MC: 'Manny',
  legacy_DH: 'Daniel H',
  legacy_DL: 'Daniel L',
  legacy_CA: 'Chris A',
  legacy_PT: 'Pete',
  legacy_JG: 'Jeff',
  legacy_TB: 'TBoy',
  legacy_BM: 'Brian',
  legacy_NP: 'Neil',
  //add real names here
};

/** Display name for prose: NAMES first, then the initials label, then '??'. */
function displayName(canonId) {
  return NAMES[canonId] || seededLabel(canonId) || '??';
}

// Populated from Firestore (meta/identityLinks) on startup and after each /link.
// LINKS[discordId] = { canonicalId, label }
let LINKS = {};

async function reloadLinks() {
  try {
    LINKS = await db.getLinks();
    console.log(`Loaded ${Object.keys(LINKS).length} identity link(s) from Firestore.`);
  } catch (err) {
    console.error('Failed to load identity links:', err.message);
    LINKS = {};
  }
}

/** Resolve any Discord/userId to its canonical id. Live links win over the seed. */
const canonicalId = (userId) =>
  LINKS[userId]?.canonicalId || IDENTITY_SEED[userId] || userId;

/** Label for a canonical id: a live link's label, else the seed, else null. */
function seededLabel(canonId) {
  if (LABELS_SEED[canonId]) return LABELS_SEED[canonId];
  const hit = Object.values(LINKS).find((l) => l.canonicalId === canonId);
  return hit ? hit.label : null;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — enable in the Developer Portal!
  ],
});

// Channels the bot listens to for score posts. Set WORDLE_CHANNEL_ID to one id,
// or several comma-separated ids, e.g. "123,456". Whitespace is ignored.
const WORDLE_CHANNEL_IDS = (process.env.WORDLE_CHANNEL_ID || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ---------- 1. Capture scores from the Wordle channel(s) ---------------------
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!WORDLE_CHANNEL_IDS.includes(message.channelId)) return;

  const parsed = parseWordleShare(message.content);
  if (!parsed) return;

  try {
    const result = await db.saveScore({
      userId: canonicalId(message.author.id),
      username: message.member?.displayName || message.author.username,
      puzzle: parsed.puzzle,
      score: parsed.score,
      failed: parsed.failed,
      hardMode: parsed.hardMode,
      weekId: weekIdForPuzzle(parsed.puzzle),
      monthId: monthIdForPuzzle(parsed.puzzle),
    });
    // ✅ new score, 🔁 repost/correction — so players know it registered
    await message.react(result === 'new' ? '✅' : '🔁');

    // ---- Milestone watch (only on brand-new scores) ----
    if (result === 'new') {
      const cid = canonicalId(message.author.id);
      const label = seededLabel(cid) || (message.member?.displayName || message.author.username);

      // Career game milestones: 100, 250, 500, 750, then every 250
      const games = await db.countGames(cid);
      const milestones = new Set([100, 250, 500, 750]);
      const isMilestone = milestones.has(games) || (games >= 1000 && games % 250 === 0);
      if (isMilestone) {
        await message.channel.send(
          `🎉 **MILESTONE!** That was ${label}'s **${games.toLocaleString()}th** Wordle on record. Legend status.`);
      }

      // First-ever ace
      if (parsed.score === 1 && !parsed.failed) {
        const aces = await db.countAces(cid);
        if (aces === 1) {
          await message.channel.send(
            `🎯 **HOLE IN ONE!** ${label} just guessed it on the FIRST TRY for the first time ever. Someone check the security cameras.`);
        } else {
          await message.channel.send(`🎯 An ace from ${label} — their ${aces}th career hole-in-one!`);
        }
      }
    }
  } catch (err) {
    console.error('saveScore failed:', err);
    await message.react('⚠️').catch(() => {});
  }
});


/** userId -> table label. Hardcoded LABELS first, then a derived fallback. */
function makeInitialsFor(interaction, scores) {
  const cache = {};
  return (userId) => {
    if (cache[userId]) return cache[userId];
    { const sl = seededLabel(userId); if (sl) return (cache[userId] = sl); }
    // fallback for anyone not in LABELS: initials from their name
    const doc = scores.find((s) => s.userId === userId);
    const name = interaction.guild?.members.cache.get(userId)?.displayName
      || doc?.username || '??';
    const words = name.trim().split(/\s+/);
    let init = words.length >= 2
      ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();
    while (Object.values(cache).includes(init)) init += '*';
    return (cache[userId] = init);
  };
}

// ---------- 2. Slash commands -------------------------------------------------

/** Label resolver that works with or without an interaction (for the daily post). */
function makeLabelFor(scores, guild) {
  const cache = {};
  return (userId) => {
    if (cache[userId]) return cache[userId];
    { const sl = seededLabel(userId); if (sl) return (cache[userId] = sl); }
    const doc = scores.find((s) => s.userId === userId);
    const name = guild?.members.cache.get(userId)?.displayName
      || doc?.username || '??';
    const words = name.trim().split(/\s+/);
    let init = words.length >= 2
      ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();
    while (Object.values(cache).includes(init)) init += '*';
    return (cache[userId] = init);
  };
}

/**
 * Build the /week image. Shared by the slash command and the 8 PM daily post.
 * @returns {png, weekId} or null if no scores yet this week.
 */
async function buildWeekImage(guild, opts = {}) {
  const refPuzzle = opts.refPuzzle ?? currentPuzzleNumber(TZ);
  const nowPuzzle = currentPuzzleNumber(TZ);
  const weekId = weekIdForPuzzle(refPuzzle);
  const scores = await db.scoresForWeek(weekId);

  // Roster = every player with a mapped Discord ID (columns appear as you add
  // IDs to IDENTITY), plus anyone who scored this week but isn't mapped yet.
  const roster = [...new Set([
    ...Object.values(IDENTITY_SEED),
    ...Object.values(LINKS).map((l) => l.canonicalId),
  ])];
  for (const s of scores) if (!roster.includes(s.userId)) roster.push(s.userId);
  const order = roster;
  if (!scores.length) return null; // nothing to show until someone scores

  const labelFor = makeLabelFor(scores, guild);

  const byCell = {};
  for (const s of scores) byCell[`${s.puzzle}_${s.userId}`] = s;

  const year = String(new Date().getFullYear());
  const seasonCounts = await db.weeklyWinCountsSince(`${year}-01-01`);
  const seasonTitles = (await db.getSeasonTitles()) ?? SEASON_TITLES_SEED;

  // For the current week, only show puzzles through today; for a finished week
  // (the Monday announcement), show all 7 days.
  const allWeekPuzzles = puzzlesInWeek(refPuzzle);
  const puzzles = opts.finished
    ? allWeekPuzzles
    : allWeekPuzzles.filter((p) => p <= nowPuzzle);

  // Totals follow the league rule: a day you skipped still costs you
  // MISSED_SCORE (default 7) and counts as a day played. Today is excluded
  // until it's over — nobody is penalized for a day still in progress.
  const MISSED = parseInt(process.env.MISSED_SCORE || '7', 10);
  const totals = {}, played = {};
  for (const id of order) {
    let total = 0, days = 0;
    for (const pz of puzzles) {
      const s = byCell[`${pz}_${id}`];
      if (s) {                       // played it
        total += s.score; days++;
      } else if (pz < nowPuzzle && MISSED > 0) {
        total += MISSED; days++;     // completed day they skipped
      }
      // else: today, not played yet — no penalty until the day is over
    }
    totals[id] = total;
    played[id] = days;
  }

  const players = order.map((id) => ({ id, label: labelFor(id) }));
  const fmtAvg = (id) => played[id] ? (totals[id] / played[id]).toFixed(1) : '·';

  // Words of the day — reveal only puzzles strictly before today (NO SPOILING).
  const words = {};
  for (const pz of puzzles) {
    if (pz >= nowPuzzle) continue; // today's answer stays secret
    const w = await db.findWord(String(pz));
    if (w) words[pz] = w.word;
  }

  // leader(s) for the callout.
  let leader, finishedChamps = null;
  if (opts.finished) {
    // Finished week: winner by the league rule (missed days penalized), matching
    // computeStandings so the crown and the recorded result agree.
    const standings = computeStandings(scores, 7);
    finishedChamps = winners(standings).map((s) => s.userId);
    const champTotal = standings.length ? standings[0].total : null;
    leader = finishedChamps.length === 1
      ? `👑 ${labelFor(finishedChamps[0])} wins the week — ${champTotal} pts`
      : `👑 Co-champions — ${finishedChamps.map(labelFor).join(' & ')} at ${champTotal} pts each`;
  } else {
    // Mid-week: only players who have played TODAY are eligible for the lead.
    // Someone who hasn't posted yet has an artificially low total, so including
    // them would fake a lead. If nobody has played today, fall back to the most
    // recent day anyone did play (yesterday, then further back if needed).
    let cutoff = null;
    for (let pz = puzzles[puzzles.length - 1]; pz >= puzzles[0]; pz--) {
      if (order.some((id) => byCell[`${pz}_${id}`])) { cutoff = pz; break; }
    }
    const contenders = order.filter((id) => byCell[`${cutoff}_${id}`]);
    const best = Math.min(...contenders.map((id) => totals[id]));
    const leaders = contenders.filter((id) => totals[id] === best);
    const stale = cutoff !== nowPuzzle ? ' (thru yesterday)' : '';
    leader = leaders.length === 1
      ? `👑 ${labelFor(leaders[0])} leads — ${best} pts, ${fmtAvg(leaders[0])} avg${stale}`
      : `⚔️ Tied at the top — ${leaders.map(labelFor).join(', ')} with ${best} pts each${stale}`;
  }

  // champion theme (falls back to defaults if none set)
  const saved = await db.getTheme();
  const t = saved || themeLib.DEFAULT_THEME;
  const theme = {
    colorAHex: themeLib.colorHex(t.colorA) || '#C0DD97',
    colorBHex: themeLib.colorHex(t.colorB) || '#F1EFE8',
    emojiChar: themeLib.emojiChar(t.emoji),
    championId: t.championId,
  };

  const png = renderWeekTable({
    title: opts.title || WEEK_TITLE,
    subtitle: opts.subtitle || WEEK_SUBTITLE,
    players,
    puzzles,
    cell: (pz, pid) => {
      const s = byCell[`${pz}_${pid}`];
      if (s) return s;
      // A completed day with no score is a miss: costs MISSED_SCORE and shows
      // as an X, same as failing to solve. Today stays blank until it's over.
      if (pz < nowPuzzle && MISSED > 0) return { score: MISSED, failed: true, missed: true };
      return null;
    },
    words,
    footerRows: [
      { label: 'pts', strong: true, values: Object.fromEntries(order.map((id) => [id, totals[id] ?? 0])) },
      { label: 'avg', values: Object.fromEntries(order.map((id) => [id, fmtAvg(id)])) },
      { label: 'seas', values: seasonCounts },
      { label: 'champ', values: seasonTitles },
    ],
    leader,
    theme,
    rules: RULES,
  });
  return { png, weekId, champs: finishedChamps || [], labelFor, seasonCounts };
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  try {
    const nowPuzzle = currentPuzzleNumber(TZ);

    if (interaction.commandName === 'week') {
      const built = await buildWeekImage(interaction.guild);
      if (!built) {
        await interaction.editReply({ content: '📅 No scores yet this week.' });
        return;
      }
      const file = new AttachmentBuilder(built.png, { name: `week-${built.weekId}.png` });
      await interaction.editReply({ files: [file] });

    } else if (interaction.commandName === 'month') {
      const monthId = monthIdForPuzzle(nowPuzzle);
      const scores = await db.scoresForMonth(monthId);
      const standings = computeStandings(scores, null);
      const labelFor = makeInitialsFor(interaction, scores);
      if (!standings.length) {
        await interaction.editReply({ content: `🗓️ **${monthId}** — no scores yet.` });
        return;
      }
      const png = renderStatsTable({
        title: monthId,
        subtitle: 'ranked by average',
        columns: [
          { key: 'G', header: 'G' },
          { key: 'pts', header: 'pts' },
          { key: 'avg', header: 'avg' },
          { key: 'X', header: 'X' },
        ],
        rows: standings.map((s, i) => ({
          label: labelFor(s.userId),
          highlight: i === 0,
          cells: { G: s.played, pts: s.rawTotal, avg: s.average?.toFixed(2) ?? '·', X: s.fails },
        })),
      });
      await interaction.editReply({
        files: [new AttachmentBuilder(png, { name: `month-${monthId}.png` })],
      });

    } else if (interaction.commandName === 'alltime') {
      const year = String(new Date().getFullYear());
      const [scores, winCounts, seasonCounts] = await Promise.all([
        db.allScores(), db.weeklyWinCounts(), db.weeklyWinCountsSince(`${year}-01-01`),
      ]);
      const standings = computeStandings(scores, null);
      const labelFor = makeInitialsFor(interaction, scores);
      if (!standings.length) {
        await interaction.editReply({ content: '🏆 **All-time** — no scores yet.' });
        return;
      }
      const png = renderStatsTable({
        title: 'All-time',
        subtitle: 'ranked by avg · X = unsolved (pre-bot totals include skips)',
        columns: [
          { key: 'G', header: 'G' },
          { key: 'pts', header: 'pts' },
          { key: 'avg', header: 'avg' },
          { key: 'X', header: 'X' },
          { key: 'seas', header: 'seas' },
          { key: 'all', header: 'all' },
        ],
        rows: standings.map((s, i) => ({
          label: labelFor(s.userId),
          highlight: i === 0,
          cells: {
            G: s.played, pts: s.rawTotal, avg: s.average?.toFixed(2) ?? '·', X: s.fails,
            seas: seasonCounts[s.userId] ?? 0, all: winCounts[s.userId] ?? 0,
          },
        })),
      });
      await interaction.editReply({
        files: [new AttachmentBuilder(png, { name: 'alltime.png' })],
      });

    } else if (interaction.commandName === 'player') {
      const user = interaction.options.getUser('user') || interaction.user;
      const cid = canonicalId(user.id);
      const [scores, winCounts] = await Promise.all([db.scoresForPlayer(cid), db.weeklyWinCounts()]);
      const name = interaction.guild?.members.cache.get(user.id)?.displayName || user.username;
      await interaction.editReply({
        embeds: [playerStatsEmbed(name, scores, winCounts[cid] || 0)],
      });

    } else if (interaction.commandName === 'versus') {
      const u1 = interaction.options.getUser('player1');
      const u2 = interaction.options.getUser('player2') || interaction.user;
      const [id1, id2] = [canonicalId(u1.id), canonicalId(u2.id)];
      if (id1 === id2) {
        await interaction.editReply('That would be shadow-boxing. Pick two different players.');
        return;
      }
      const [s1, s2] = await Promise.all([db.scoresForPlayer(id1), db.scoresForPlayer(id2)]);
      const labelFor = makeLabelFor([...s1, ...s2], interaction.guild);
      const [n1, n2] = [labelFor(id1), labelFor(id2)];
      if (!s1.length || !s2.length) {
        await interaction.editReply(`Not enough data — ${!s1.length ? n1 : n2} has no recorded games.`);
        return;
      }
      const v = fun.versus(s1, s2);
      if (!v.shared) {
        await interaction.editReply(`${n1} and ${n2} have never played the same puzzle. Ships in the night.`);
        return;
      }
      const dailyEdge = v.aWins === v.bWins ? 'DEAD EVEN' : (v.aWins > v.bWins ? n1 : n2);
      const lines = [
        `⚔️ **${n1} vs ${n2}** — ${v.shared.toLocaleString()} shared puzzles`,
        '',
        `**Daily wins:** ${n1} ${v.aWins} — ${v.bWins} ${n2} (${v.ties} ties) → edge: **${dailyEdge}**`,
        `**Avg on shared puzzles:** ${n1} ${(v.aSum / v.shared).toFixed(2)} — ${(v.bSum / v.shared).toFixed(2)} ${n2}`,
        `**Shared weeks won:** ${n1} ${v.aWeekWins} — ${v.bWeekWins} ${n2} (${v.weekTies} ties, ${v.sharedWeeks} weeks)`,
      ];
      await interaction.editReply(lines.join('\n'));

    } else if (interaction.commandName === 'word') {
      const q = interaction.options.getString('word').trim();
      const found = await db.findWord(q);
      if (!found) {
        await interaction.editReply(
          `No record of **${q.toUpperCase()}** — either it wasn't a puzzle during recorded history, or the word for that day wasn't logged.`);
        return;
      }
      // Rule #3: NO SPOILING. Never reveal today's (or a future) answer.
      if (found.puzzle >= currentPuzzleNumber(TZ)) {
        await interaction.editReply('🤐 Nice try. Rule #3: NO SPOILING. Ask me again tomorrow.');
        return;
      }
      const scores = await db.scoresForPuzzle(found.puzzle);
      const labelFor = makeLabelFor(scores, interaction.guild);
      const date = new Date(Date.UTC(2021, 5, 19) + found.puzzle * 86_400_000)
        .toISOString().slice(0, 10);
      let body = `📖 **${found.word}** — Wordle #${found.puzzle.toLocaleString()} (${date})\n`;
      if (!scores.length) {
        body += '\nNo one in the league has a recorded score for this one.';
      } else {
        const sorted = [...scores].sort((a, b) => a.score - b.score);
        body += '\n' + sorted.map((s) =>
          `${s.failed ? '❌' : s.score <= 2 ? '🌟' : '🟩'} **${labelFor(s.userId)}** — ${s.failed ? 'X' : s.score}/6`).join('\n');
        const best = sorted[0], worst = sorted[sorted.length - 1];
        if (scores.length >= 2 && best.score !== worst.score) {
          body += `\n\nBragging rights: **${labelFor(best.userId)}**. Condolences: **${labelFor(worst.userId)}**.`;
        }
      }
      await interaction.editReply(body);

    } else if (interaction.commandName === 'roast') {
      const user = interaction.options.getUser('user') || interaction.user;
      const cid = canonicalId(user.id);
      const scores = await db.scoresForPlayer(cid);
      const name = displayName(cid);
      if (scores.length < 20) {
        await interaction.editReply(`${name} hasn't played enough to roast. Come back when there's a body of work. 📉`);
        return;
      }
      const stats = fun.playerStats(scores);
      // Try AI for variety; fall back to the canned lines if it's unavailable.
      const aiLine = await ai.roast(name, stats);
      const lines = fun.roastLines(name, stats);
      const pick = aiLine || lines[Math.floor(Math.random() * lines.length)];
      await interaction.editReply(`🔥 ${pick}`);

    } else if (interaction.commandName === 'fortune') {
      const cid = canonicalId(interaction.user.id);
      const scores = await db.scoresForPlayer(cid);
      const today = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
      const dateStr = today.toISOString().slice(0, 10);
      if (scores.length < 10) {
        await interaction.editReply('🔮 The mists are cloudy... play more Wordles and your destiny shall reveal itself.');
        return;
      }
      const stats = fun.playerStats(scores);
      const name = displayName(cid);
      const aiFortune = await ai.fortune(name, stats, fun.DAY_NAMES[today.getDay()]);
      const lines = fun.fortuneLines(name, stats, today.getDay());
      const pick = aiFortune || fun.dailyPick(lines, cid, dateStr);
      await interaction.editReply(pick);

    } else if (interaction.commandName === 'colors') {
      const list = themeLib.colorNames().join(', ');
      await interaction.editReply(
        `🎨 **Available colors** (use with \`/champion colors\`):\n${list}`);

    } else if (interaction.commandName === 'emojis') {
      const list = themeLib.emojiNames()
        .map((n) => `${themeLib.emojiChar(n)} \`${n}\``).join('   ');
      await interaction.editReply(
        `😀 **Champion emojis** (use with \`/champion icon\`):\n${list}`);

    } else if (interaction.commandName === 'champion') {
      const championId = await db.currentChampionId();
      // permission: only the reigning champion may set the theme
      if (!championId) {
        await interaction.editReply(
          'No champion has been crowned yet — the theme unlocks after the first weekly announcement.');
        return;
      }
      if (canonicalId(interaction.user.id) !== championId) {
        await interaction.editReply(
          '🔒 Only the reigning weekly champion can change the theme. Win a week to earn it!');
        return;
      }

      const sub = interaction.options.getSubcommand();
      if (sub === 'colors') {
        const c1 = interaction.options.getString('color1').toLowerCase();
        const c2 = interaction.options.getString('color2').toLowerCase();
        const bad = [c1, c2].filter((c) => !themeLib.colorHex(c));
        if (bad.length) {
          await interaction.editReply(
            `Unknown color: ${bad.join(', ')}. Run \`/colors\` to see valid names.`);
          return;
        }
        await db.setTheme({ colorA: c1, colorB: c2, championId });
        await interaction.editReply(
          `✅ Week table will now alternate **${c1}** and **${c2}**. Run \`/week\` to see it.`);
      } else if (sub === 'icon') {
        const emoji = interaction.options.getString('emoji').toLowerCase();
        if (!themeLib.emojiChar(emoji)) {
          await interaction.editReply(
            `Unknown emoji: ${emoji}. Run \`/emojis\` to see valid names.`);
          return;
        }
        await db.setTheme({ emoji, championId });
        await interaction.editReply(
          `✅ ${themeLib.emojiChar(emoji)} will fly over your initials in \`/week\`.`);
      }

    } else if (interaction.commandName === 'help') {
      const help = [
        '**🟩 Brodle League Bot — commands**',
        '',
        'Paste your NYT Wordle share (e.g. `Wordle 1,854 3/6`) in the scores channel and I record it automatically (✅ = saved, 🔁 = updated).',
        '',
        '`/week` — this week\'s table (Mon–Sun) with points, averages, and win tallies',
        '`/month` — this month\'s leaderboard, ranked by average',
        '`/alltime` — full-history leaderboard and weekly title counts',
        '`/player [user]` — one player\'s stats and guess distribution',
        '`/versus <p1> [p2]` — head-to-head record between two players',
        '`/word <word>` — look up a past word and how everyone scored on it',
        '`/roast [user]` — a statistically accurate burn',
        '`/fortune` — your Wordle fortune for today',
        '`/colors` — list color names for the champion theme',
        '`/emojis` — list champion emoji names',
        '`/champion colors <c1> <c2>` — *(champion only)* set the two alternating week colors',
        '`/champion icon <emoji>` — *(champion only)* set the emoji over your initials',
        '`/link set <member> <label>` — *(admin)* map a member to a player',
        '`/help` — this message',
        '',
        'Each Monday at 4 AM I crown the previous week\'s winner (lowest total). The champion gets to theme the `/week` table until someone dethrones them. 👑',
      ].join('\n');
      await interaction.editReply(help);

    } else if (interaction.commandName === 'link') {
      // Admin gate: Manage Server. (Discord also hides it via default perms,
      // but we re-check in case the command is invoked another way.)
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply('🔒 Only server admins can manage player links.');
        return;
      }
      const sub = interaction.options.getSubcommand();

      if (sub === 'set') {
        const member = interaction.options.getUser('member');
        const label = interaction.options.getString('label').trim();
        // canonical id: explicit, else derive legacy_<LABEL> so history can merge
        const canonical = (interaction.options.getString('canonical')
          || `legacy_${label.toUpperCase()}`).trim();
        await db.setLink(member.id, canonical, label);
        await reloadLinks();

        // Absorb any scores the member already posted under their raw Discord id
        // (before being linked) into the canonical id.
        let rekeyNote = '';
        try {
          const { moved, kept } = await db.rekeyScores(member.id, canonical);
          if (moved || kept) {
            rekeyNote = `\nMoved **${moved}** existing score(s) into \`${canonical}\``
              + (kept ? ` (kept ${kept} where a better score already existed).` : '.');
          }
        } catch (err) {
          console.error('rekey during /link failed:', err);
          rekeyNote = '\n⚠️ Linked, but re-keying old scores failed — check logs.';
        }

        await interaction.editReply(
          `✅ Linked <@${member.id}> → **${label}** (canonical \`${canonical}\`).`
          + `\nTheir posts now save under \`${canonical}\`.${rekeyNote}`);

      } else if (sub === 'list') {
        const links = await db.getLinks();
        const entries = Object.entries(links);
        if (!entries.length) {
          await interaction.editReply('No live links yet. The seed map still applies to known players.');
          return;
        }
        const body = entries
          .map(([id, v]) => `• <@${id}> → **${v.label}** (\`${v.canonicalId}\`)`)
          .join('\n');
        await interaction.editReply(`🔗 **Live player links**\n${body}`);

      } else if (sub === 'remove') {
        const member = interaction.options.getUser('member');
        await db.removeLink(member.id);
        await reloadLinks();
        await interaction.editReply(`🗑️ Removed link for <@${member.id}>.`);
      }
    }
  } catch (err) {
    console.error(err);
    await interaction.editReply('Something went wrong pulling the stats. Check the bot logs.');
  }
});

/** Puzzles that have been published so far in the current week (1..7). */
function puzzlesElapsedThisWeek(nowPuzzle) {
  const week = puzzlesInWeek(nowPuzzle);
  return week.filter((p) => p <= nowPuzzle).length;
}

// ---------- 3. Monday 4:00 AM weekly announcement ------------------------------
async function announceLastWeek() {
  // Last week = the week containing yesterday's (Sunday's) puzzle.
  const lastWeekPuzzle = currentPuzzleNumber(TZ) - 1;
  const weekId = weekIdForPuzzle(lastWeekPuzzle);

  if (await db.weekAlreadyAnnounced(weekId)) {
    console.log(`Week ${weekId} already announced, skipping.`);
    return;
  }

  const channel = await client.channels.fetch(process.env.ANNOUNCE_CHANNEL_ID);

  // Build the final-standings image in the same style as /week (all 7 days,
  // updated season points). champs come back as canonical ids.
  const built = await buildWeekImage(channel.guild, {
    refPuzzle: lastWeekPuzzle,
    finished: true,
    title: `🏁 Final Standings — week of ${weekId}`,
  });

  if (!built) {
    await channel.send(`No Wordle scores recorded for the week of ${weekId}. Sad week. 😔`);
    return;
  }

  const { champs, labelFor } = built;
  const crownLine = champs.length === 1
    ? `👑 **${labelFor(champs[0])}** is the Wordle champion for the week of ${weekId}! New week starts today — good luck! 🟩`
    : `👑 Co-champions for the week of ${weekId}: ${champs.map(labelFor).join(' & ')}! New week starts today — good luck! 🟩`;

  await channel.send({
    content: crownLine,
    files: [new AttachmentBuilder(built.png, { name: `final-${weekId}.png` })],
  });

  // Record the result (winners stored as canonical ids) so season/all-time
  // tallies and the champion-theme permission update.
  const scores = await db.scoresForWeek(weekId);
  const standings = computeStandings(scores, 7);
  await db.recordWeekResult(
    weekId,
    standings.map(({ dist, ...s }) => s),
    champs, // canonical ids
  );
  console.log(`Announced week ${weekId}.`);
}

/** Post the current /week table to the announce channel (8 PM daily). */
async function postDailyWeek() {
  const channel = await client.channels.fetch(process.env.ANNOUNCE_CHANNEL_ID);
  const built = await buildWeekImage(channel.guild);
  if (!built) {
    console.log('Daily post skipped: no scores this week yet.');
    return;
  }
  await channel.send({
    files: [new AttachmentBuilder(built.png, { name: `week-${built.weekId}.png` })],
  });
  console.log(`Posted daily week table for ${built.weekId}.`);
}

/**
 * Fetch the answer for a given puzzle number from the NYT's own JSON endpoint
 * (the same one the game loads). Unofficial but stable for years; no key needed.
 */
async function fetchWordForPuzzle(puzzle) {
  const date = new Date(Date.UTC(2021, 5, 19) + puzzle * 86_400_000)
    .toISOString().slice(0, 10);
  const res = await fetch(`https://www.nytimes.com/svc/wordle/v2/${date}.json`);
  if (!res.ok) throw new Error(`NYT responded ${res.status} for ${date}`);
  const data = await res.json();
  if (!data.solution) throw new Error(`No solution in NYT payload for ${date}`);
  // Trust NYT's own numbering if present (guards against any epoch drift)
  const num = Number.isInteger(data.days_since_launch) ? data.days_since_launch : puzzle;
  return { puzzle: num, word: data.solution.toUpperCase(), date };
}

/**
 * Archive words up to YESTERDAY's puzzle (never today's — rule #3: NO SPOILING).
 * Catches up any gap since the last stored word, so bot downtime never loses
 * words. Runs daily at 1 AM and once on startup.
 */
async function archiveWords() {
  const safeMax = currentPuzzleNumber(TZ) - 1; // yesterday's puzzle is fair game
  let from = (await db.latestWordPuzzle() ?? safeMax - 1) + 1;
  if (from > safeMax) return;
  // safety cap so a weird state can't hammer NYT
  from = Math.max(from, safeMax - 60);
  for (let p = from; p <= safeMax; p++) {
    try {
      const w = await fetchWordForPuzzle(p);
      await db.saveWord(w.puzzle, w.word, w.date);
      console.log(`Archived word #${w.puzzle}: ${w.word}`);
    } catch (err) {
      console.error(`Word archive failed for #${p}:`, err.message);
      break; // stop on failure; next run resumes from the same spot
    }
  }
}

/**
 * January 1st: crown the season champion (most weekly wins in the ended year),
 * bump their seasons-won tally, reset the season counter, announce.
 * Idempotent per year — safe if the bot restarts on New Year's Day.
 */
async function announceSeasonChampion() {
  const endedYear = new Date(new Date().toLocaleString('en-US', { timeZone: TZ })).getFullYear() - 1;

  // Final season tally = weekly wins during the ended year (incl. legacy carryover)
  const counts = await db.weeklyWinCountsSince(`${endedYear}-01-01`);
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (!entries.length) { console.log(`Season ${endedYear}: no weekly wins recorded, skipping.`); return; }

  const best = Math.max(...entries.map(([, n]) => n));
  const winnerIds = entries.filter(([, n]) => n === best).map(([id]) => id);

  // Idempotency: only proceed if this year hasn't been recorded
  const fresh = await db.recordSeasonResult(endedYear, winnerIds, counts);
  if (!fresh) { console.log(`Season ${endedYear} already announced, skipping.`); return; }

  // Increment seasons-won (seeding from the hardcoded map on first ever rollover)
  const titles = (await db.getSeasonTitles()) ?? { ...SEASON_TITLES_SEED };
  for (const id of winnerIds) titles[id] = (titles[id] || 0) + 1;
  await db.setSeasonTitles(titles);

  // New season starts at zero
  await db.clearLegacyCurrentSeason();

  const channel = await client.channels.fetch(process.env.ANNOUNCE_CHANNEL_ID);
  const scores = await db.allScores(); // just for label fallback
  const labelFor = makeLabelFor(scores, channel.guild);
  const names = winnerIds.map(labelFor).join(' & ');
  const line = winnerIds.length === 1
    ? `🎆 **${names} is the ${endedYear} SEASON CHAMPION** with ${best} weekly wins! A new season begins today — good luck everyone. 🟩`
    : `🎆 **Co-champions of the ${endedYear} season: ${names}** with ${best} weekly wins each! A new season begins today. 🟩`;
  await channel.send(line);
  console.log(`Announced season ${endedYear} champion(s): ${names}`);
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  reloadLinks(); // load live player links from Firestore
  // Monday 4:00 AM in the league timezone. The Mon-Sun week ended at midnight;
  // the 4-hour buffer lets night owls post Sunday's puzzle late.
  cron.schedule('0 4 * * 1', () => {
    announceLastWeek().catch((err) => console.error('announce failed:', err));
  }, { timezone: TZ });
  // Daily standings post at 8:00 PM in the league timezone.
  cron.schedule('0 20 * * *', () => {
    postDailyWeek().catch((err) => console.error('daily post failed:', err));
  }, { timezone: TZ });
  // January 1st, 12:05 AM: crown the season champion and start the new season.
  cron.schedule('5 0 1 1 *', () => {
    announceSeasonChampion().catch((err) => console.error('season rollover failed:', err));
  }, { timezone: TZ });
  // 1:00 AM daily: archive yesterday's word from the NYT endpoint (with catch-up).
  cron.schedule('0 1 * * *', () => {
    archiveWords().catch((err) => console.error('word archive failed:', err));
  }, { timezone: TZ });
  // Also catch up on startup, so redeploys/downtime never leave gaps.
  archiveWords().catch((err) => console.error('startup word catch-up failed:', err));
  console.log(`Scheduled: Mon 4 AM weekly announce, daily 8 PM standings, daily 1 AM word archive, Jan 1 season rollover (${TZ}).`);
});

client.login(process.env.DISCORD_TOKEN);
