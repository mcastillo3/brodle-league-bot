require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
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

const TZ = process.env.TIMEZONE || 'America/Chicago';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — enable in the Developer Portal!
  ],
});

// ---------- 1. Capture scores from the Wordle channel ------------------------
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== process.env.WORDLE_CHANNEL_ID) return;

  const parsed = parseWordleShare(message.content);
  if (!parsed) return;

  try {
    const result = await db.saveScore({
      userId: message.author.id,
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
  } catch (err) {
    console.error('saveScore failed:', err);
    await message.react('⚠️').catch(() => {});
  }
});


/** userId -> spreadsheet-style initials, derived from server display names. */
function makeInitialsFor(interaction, scores) {
  const cache = {};
  return (userId) => {
    if (cache[userId]) return cache[userId];
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
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  try {
    const nowPuzzle = currentPuzzleNumber(TZ);

    if (interaction.commandName === 'week') {
      const weekId = weekIdForPuzzle(nowPuzzle);
      const [scores, winCounts] = await Promise.all([
        db.scoresForWeek(weekId), db.weeklyWinCounts(),
      ]);

      const initialsFor = makeInitialsFor(interaction, scores);

      const order = [...new Set(scores.map((s) => s.userId))];
      let table = formatWeekGrid(scores, puzzlesInWeek(nowPuzzle), nowPuzzle, initialsFor);

      // season wins (weekly titles this calendar year) + all-time, like the sheet
      if (order.length) {
        const year = String(new Date().getFullYear());
        const seasonCounts = await db.weeklyWinCountsSince(`${year}-01-01`);
        const tally = formatTallyRows(order, initialsFor, [
          { label: 'seas:', values: seasonCounts },
          { label: 'all:', values: winCounts },
        ]);
        table = table.replace(/\n```$/, '\n' + tally + '\n```');
      }

      await interaction.editReply({
        content: `📅 **Week of ${weekId}**\n${table}`,
      });

    } else if (interaction.commandName === 'month') {
      const monthId = monthIdForPuzzle(nowPuzzle);
      const scores = await db.scoresForMonth(monthId);
      const standings = computeStandings(scores, null);
      const initialsFor = makeInitialsFor(interaction, scores);
      await interaction.editReply({
        content: `🗓️ **${monthId}** · ranked by avg\n`
          + formatStatsTable(standings, initialsFor),
      });

    } else if (interaction.commandName === 'alltime') {
      const year = String(new Date().getFullYear());
      const [scores, winCounts, seasonCounts] = await Promise.all([
        db.allScores(), db.weeklyWinCounts(), db.weeklyWinCountsSince(`${year}-01-01`),
      ]);
      const standings = computeStandings(scores, null);
      const initialsFor = makeInitialsFor(interaction, scores);
      await interaction.editReply({
        content: '🏆 **All-time** · ranked by avg\n'
          + formatStatsTable(standings, initialsFor, [
              { header: 'seas', values: seasonCounts },
              { header: 'all', values: winCounts },
            ]),
      });

    } else if (interaction.commandName === 'player') {
      const user = interaction.options.getUser('user') || interaction.user;
      const [scores, winCounts] = await Promise.all([db.scoresForPlayer(user.id), db.weeklyWinCounts()]);
      const name = interaction.guild?.members.cache.get(user.id)?.displayName || user.username;
      await interaction.editReply({
        embeds: [playerStatsEmbed(name, scores, winCounts[user.id] || 0)],
      });
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

  const scores = await db.scoresForWeek(weekId);
  const standings = computeStandings(scores, 7);
  const champs = winners(standings);

  const channel = await client.channels.fetch(process.env.ANNOUNCE_CHANNEL_ID);
  if (!standings.length) {
    await channel.send(`No Wordle scores recorded for the week of ${weekId}. Sad week. 😔`);
    return;
  }

  const crownLine = champs.length === 1
    ? `👑 **${champs[0].username}** is the Wordle champion for the week of ${weekId}!`
    : `👑 Co-champions for the week of ${weekId}: ${champs.map((c) => `**${c.username}**`).join(' & ')}!`;

  await channel.send({
    content: crownLine,
    embeds: [standingsEmbed(`🏁 Final standings — week of ${weekId}`, standings,
      { footer: 'New week starts today. Good luck! 🟩' })],
  });

  await db.recordWeekResult(
    weekId,
    standings.map(({ dist, ...s }) => s), // dist keys are numbers; keep doc clean
    champs.map((c) => c.userId),
  );
  console.log(`Announced week ${weekId}.`);
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  // Monday 4:00 AM in the league timezone. The Mon-Sun week ended at midnight;
  // the 4-hour buffer lets night owls post Sunday's puzzle late.
  cron.schedule('0 4 * * 1', () => {
    announceLastWeek().catch((err) => console.error('announce failed:', err));
  }, { timezone: TZ });
  console.log(`Weekly announcement scheduled for Mondays 4:00 AM ${TZ}.`);
});

client.login(process.env.DISCORD_TOKEN);
