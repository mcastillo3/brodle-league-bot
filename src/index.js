require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Events,
  AttachmentBuilder,
} = require("discord.js");
const cron = require("node-cron");

const {
  parseWordleShare,
  currentPuzzleNumber,
  weekIdForPuzzle,
  puzzlesInWeek,
  monthIdForPuzzle,
} = require("./parser");
const db = require("./db");
const {
  computeStandings,
  winners,
  standingsEmbed,
  playerStatsEmbed,
  formatWeekGrid,
  formatTallyRows,
  formatStatsTable,
} = require("./leaderboard");
const { renderWeekTable, renderStatsTable } = require("./imageTable");
const themeLib = require("./theme");

// League rules shown in the /week footer. Edit these lines freely.
const RULES = [
  "1) PLAY W HONOR ✅",
  "2) NO CHEATING ✅",
  "3) NO SPOILING ✅",
  "4) HAVE FUN ✅",
];
const WEEK_TITLE = "NEW NEW BRODLE ORDER";
const WEEK_SUBTITLE = "shall play 20 years w/ honor & harmonious";

const TZ = process.env.TIMEZONE || "America/Chicago";

// Player labels shown in the table images. Keyed by userId — either a
// legacy_XX id (historical/backfilled scores) or a real Discord id (live
// posts). Map both to the same initials so a player reads identically
// whichever era their scores came from.
const LABELS = {
  legacy_BG: "BG",
  legacy_MC: "MC",
  legacy_DH: "DH",
  legacy_DL: "DL",
  legacy_CA: "CA",
  legacy_PT: "PT",
  legacy_JG: "JG",
  legacy_TB: "TB",
  legacy_BM: "BM",
  legacy_NP: "NP",
  // real Discord IDs (fill in as you learn them), pointing at the same initials:
  // '1514100951508844655': 'BG',
};

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
    await message.react(result === "new" ? "✅" : "🔁");
  } catch (err) {
    console.error("saveScore failed:", err);
    await message.react("⚠️").catch(() => {});
  }
});

/** userId -> table label. Hardcoded LABELS first, then a derived fallback. */
function makeInitialsFor(interaction, scores) {
  const cache = {};
  return (userId) => {
    if (cache[userId]) return cache[userId];
    if (LABELS[userId]) return (cache[userId] = LABELS[userId]);
    // fallback for anyone not in LABELS: initials from their name
    const doc = scores.find((s) => s.userId === userId);
    const name =
      interaction.guild?.members.cache.get(userId)?.displayName ||
      doc?.username ||
      "??";
    const words = name.trim().split(/\s+/);
    let init =
      words.length >= 2
        ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();
    while (Object.values(cache).includes(init)) init += "*";
    return (cache[userId] = init);
  };
}

// ---------- 2. Slash commands -------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();

  try {
    const nowPuzzle = currentPuzzleNumber(TZ);

    if (interaction.commandName === "week") {
      const weekId = weekIdForPuzzle(nowPuzzle);
      const [scores, winCounts] = await Promise.all([
        db.scoresForWeek(weekId),
        db.weeklyWinCounts(),
      ]);
      const labelFor = makeInitialsFor(interaction, scores);

      const order = [...new Set(scores.map((s) => s.userId))];
      if (!order.length) {
        await interaction.editReply({
          content: `📅 **Week of ${weekId}** — no scores yet.`,
        });
        return;
      }

      // build lookup + footer data
      const byCell = {};
      const totals = {},
        played = {};
      for (const s of scores) {
        byCell[`${s.puzzle}_${s.userId}`] = s;
        totals[s.userId] = (totals[s.userId] || 0) + s.score;
        played[s.userId] = (played[s.userId] || 0) + 1;
      }
      const year = String(new Date().getFullYear());
      const seasonCounts = await db.weeklyWinCountsSince(`${year}-01-01`);

      const puzzles = puzzlesInWeek(nowPuzzle).filter((p) => p <= nowPuzzle);
      const players = order.map((id) => ({ id, label: labelFor(id) }));
      const fmtAvg = (id) =>
        played[id] ? (totals[id] / played[id]).toFixed(1) : "·";

      // current leader (lowest total among those who played)
      const leadId = [...order].sort((a, b) => totals[a] - totals[b])[0];
      const leader =
        `👑 ${labelFor(leadId)} leads — ${totals[leadId]} pts, ` +
        `${fmtAvg(leadId)} avg`;

      // champion theme (falls back to defaults if none set)
      const saved = await db.getTheme();
      const t = saved || themeLib.DEFAULT_THEME;
      const theme = {
        colorAHex: themeLib.colorHex(t.colorA) || "#C0DD97",
        colorBHex: themeLib.colorHex(t.colorB) || "#F1EFE8",
        emojiChar: themeLib.emojiChar(t.emoji),
        championId: t.championId,
      };

      const png = renderWeekTable({
        title: WEEK_TITLE,
        subtitle: WEEK_SUBTITLE,
        players,
        puzzles,
        cell: (pz, pid) => byCell[`${pz}_${pid}`] || null,
        footerRows: [
          {
            label: "pts",
            strong: true,
            values: Object.fromEntries(
              order.map((id) => [id, totals[id] ?? 0])
            ),
          },
          {
            label: "avg",
            values: Object.fromEntries(order.map((id) => [id, fmtAvg(id)])),
          },
          { label: "seas", values: seasonCounts },
          { label: "all", values: winCounts },
        ],
        leader,
        theme,
        rules: RULES,
      });

      const file = new AttachmentBuilder(png, { name: `week-${weekId}.png` });
      await interaction.editReply({ files: [file] });
    } else if (interaction.commandName === "month") {
      const monthId = monthIdForPuzzle(nowPuzzle);
      const scores = await db.scoresForMonth(monthId);
      const standings = computeStandings(scores, null);
      const labelFor = makeInitialsFor(interaction, scores);
      if (!standings.length) {
        await interaction.editReply({
          content: `🗓️ **${monthId}** — no scores yet.`,
        });
        return;
      }
      const png = renderStatsTable({
        title: monthId,
        subtitle: "ranked by average",
        columns: [
          { key: "G", header: "G" },
          { key: "pts", header: "pts" },
          { key: "avg", header: "avg" },
          { key: "X", header: "X" },
        ],
        rows: standings.map((s, i) => ({
          label: labelFor(s.userId),
          highlight: i === 0,
          cells: {
            G: s.played,
            pts: s.rawTotal,
            avg: s.average?.toFixed(2) ?? "·",
            X: s.fails,
          },
        })),
      });
      await interaction.editReply({
        files: [new AttachmentBuilder(png, { name: `month-${monthId}.png` })],
      });
    } else if (interaction.commandName === "alltime") {
      const year = String(new Date().getFullYear());
      const [scores, winCounts, seasonCounts] = await Promise.all([
        db.allScores(),
        db.weeklyWinCounts(),
        db.weeklyWinCountsSince(`${year}-01-01`),
      ]);
      const standings = computeStandings(scores, null);
      const labelFor = makeInitialsFor(interaction, scores);
      if (!standings.length) {
        await interaction.editReply({
          content: "🏆 **All-time** — no scores yet.",
        });
        return;
      }
      const png = renderStatsTable({
        title: "All-time",
        subtitle: "ranked by average",
        columns: [
          { key: "G", header: "G" },
          { key: "pts", header: "pts" },
          { key: "avg", header: "avg" },
          { key: "X", header: "X" },
          { key: "seas", header: "seas" },
          { key: "all", header: "all" },
        ],
        rows: standings.map((s, i) => ({
          label: labelFor(s.userId),
          highlight: i === 0,
          cells: {
            G: s.played,
            pts: s.rawTotal,
            avg: s.average?.toFixed(2) ?? "·",
            X: s.fails,
            seas: seasonCounts[s.userId] ?? 0,
            all: winCounts[s.userId] ?? 0,
          },
        })),
      });
      await interaction.editReply({
        files: [new AttachmentBuilder(png, { name: "alltime.png" })],
      });
    } else if (interaction.commandName === "player") {
      const user = interaction.options.getUser("user") || interaction.user;
      const [scores, winCounts] = await Promise.all([
        db.scoresForPlayer(user.id),
        db.weeklyWinCounts(),
      ]);
      const name =
        interaction.guild?.members.cache.get(user.id)?.displayName ||
        user.username;
      await interaction.editReply({
        embeds: [playerStatsEmbed(name, scores, winCounts[user.id] || 0)],
      });
    } else if (interaction.commandName === "colors") {
      const list = themeLib.colorNames().join(", ");
      await interaction.editReply(
        `🎨 **Available colors** (use with \`/champion colors\`):\n${list}`
      );
    } else if (interaction.commandName === "emojis") {
      const list = themeLib
        .emojiNames()
        .map((n) => `${themeLib.emojiChar(n)} \`${n}\``)
        .join("   ");
      await interaction.editReply(
        `😀 **Champion emojis** (use with \`/champion icon\`):\n${list}`
      );
    } else if (interaction.commandName === "champion") {
      const championId = await db.currentChampionId();
      // permission: only the reigning champion may set the theme
      if (!championId) {
        await interaction.editReply(
          "No champion has been crowned yet — the theme unlocks after the first weekly announcement."
        );
        return;
      }
      if (interaction.user.id !== championId) {
        await interaction.editReply(
          "🔒 Only the reigning weekly champion can change the theme. Win a week to earn it!"
        );
        return;
      }

      const sub = interaction.options.getSubcommand();
      if (sub === "colors") {
        const c1 = interaction.options.getString("color1").toLowerCase();
        const c2 = interaction.options.getString("color2").toLowerCase();
        const bad = [c1, c2].filter((c) => !themeLib.colorHex(c));
        if (bad.length) {
          await interaction.editReply(
            `Unknown color: ${bad.join(
              ", "
            )}. Run \`/colors\` to see valid names.`
          );
          return;
        }
        await db.setTheme({ colorA: c1, colorB: c2, championId });
        await interaction.editReply(
          `✅ Week table will now alternate **${c1}** and **${c2}**. Run \`/week\` to see it.`
        );
      } else if (sub === "icon") {
        const emoji = interaction.options.getString("emoji").toLowerCase();
        if (!themeLib.emojiChar(emoji)) {
          await interaction.editReply(
            `Unknown emoji: ${emoji}. Run \`/emojis\` to see valid names.`
          );
          return;
        }
        await db.setTheme({ emoji, championId });
        await interaction.editReply(
          `✅ ${themeLib.emojiChar(
            emoji
          )} will fly over your initials in \`/week\`.`
        );
      }
    } else if (interaction.commandName === "help") {
      const help = [
        "**🟩 Brodle League Bot — commands**",
        "",
        "Paste your NYT Wordle score in here and I record it automatically (✅ = saved, 🔁 = updated).",
        "",
        "`/week` — this week's table (Mon–Sun) with points, averages, and win tallies",
        "`/month` — this month's leaderboard, ranked by average",
        "`/alltime` — full-history leaderboard and weekly title counts",
        "`/player [user]` — one player's stats and guess distribution",
        "`/colors` — list color names for the champion theme",
        "`/emojis` — list champion emoji names",
        "`/champion colors <c1> <c2>` — *(champion only)* set the two alternating week colors",
        "`/champion icon <emoji>` — *(champion only)* set the emoji over your initials",
        "`/help` — this message",
        "",
        "Each Monday at 4 AM I crown the previous week's winner (lowest total). The champion gets to theme the `/week` table until someone dethrones them. 👑",
      ].join("\n");
      await interaction.editReply(help);
    }
  } catch (err) {
    console.error(err);
    await interaction.editReply(
      "Something went wrong pulling the stats. Check the bot logs."
    );
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
    await channel.send(
      `No Wordle scores recorded for the week of ${weekId}. Sad week. 😔`
    );
    return;
  }

  const crownLine =
    champs.length === 1
      ? `👑 **${champs[0].username}** is the Wordle champion for the week of ${weekId}!`
      : `👑 Co-champions for the week of ${weekId}: ${champs
          .map((c) => `**${c.username}**`)
          .join(" & ")}!`;

  await channel.send({
    content: crownLine,
    embeds: [
      standingsEmbed(`🏁 Final standings — week of ${weekId}`, standings, {
        footer: "New week starts today. Good luck! 🟩",
      }),
    ],
  });

  await db.recordWeekResult(
    weekId,
    standings.map(({ dist, ...s }) => s), // dist keys are numbers; keep doc clean
    champs.map((c) => c.userId)
  );
  console.log(`Announced week ${weekId}.`);
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  // Monday 4:00 AM in the league timezone. The Mon-Sun week ended at midnight;
  // the 4-hour buffer lets night owls post Sunday's puzzle late.
  cron.schedule(
    "0 4 * * 1",
    () => {
      announceLastWeek().catch((err) => console.error("announce failed:", err));
    },
    { timezone: TZ }
  );
  console.log(`Weekly announcement scheduled for Mondays 4:00 AM ${TZ}.`);
});

client.login(process.env.DISCORD_TOKEN);
