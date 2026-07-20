/** Registers slash commands with Discord. Run once (and after any command changes):
 *    npm run deploy
 */
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('week')
    .setDescription('Current week leaderboard (Mon–Sun)'),
  new SlashCommandBuilder().setName('month')
    .setDescription('Current month leaderboard'),
  new SlashCommandBuilder().setName('alltime')
    .setDescription('All-time leaderboard and weekly title counts'),
  new SlashCommandBuilder().setName('player')
    .setDescription('Stats for one player')
    .addUserOption((o) =>
      o.setName('user').setDescription('Player (defaults to you)').setRequired(false)),

  new SlashCommandBuilder().setName('versus')
    .setDescription('Head-to-head record between two players')
    .addUserOption((o) => o.setName('player1').setDescription('First player').setRequired(true))
    .addUserOption((o) => o.setName('player2').setDescription('Second player (defaults to you)').setRequired(false)),
  new SlashCommandBuilder().setName('word')
    .setDescription('Look up a past word of the day and how everyone scored')
    .addStringOption((o) => o.setName('word').setDescription('The word (or a puzzle number)').setRequired(true)),
  new SlashCommandBuilder().setName('roast')
    .setDescription('A statistically accurate burn')
    .addUserOption((o) => o.setName('user').setDescription('Victim (defaults to you)').setRequired(false)),
  new SlashCommandBuilder().setName('fortune')
    .setDescription('Your Wordle fortune for today'),

  new SlashCommandBuilder().setName('champion')
    .setDescription('Reigning champion: set the weekly table theme')
    .addSubcommand((s) => s.setName('colors')
      .setDescription('Pick two colors the week table alternates between')
      .addStringOption((o) => o.setName('color1').setDescription('First color name').setRequired(true))
      .addStringOption((o) => o.setName('color2').setDescription('Second color name').setRequired(true)))
    .addSubcommand((s) => s.setName('icon')
      .setDescription('Pick the emoji shown over your initials')
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji name (see /emojis)').setRequired(true))),

  new SlashCommandBuilder().setName('colors')
    .setDescription('List the color names you can choose for the theme'),
  new SlashCommandBuilder().setName('emojis')
    .setDescription('List the champion emoji names you can choose'),
  new SlashCommandBuilder().setName('help')
    .setDescription('Explain every command this bot understands'),
].map((c) => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands },
  );
  console.log(`Registered ${commands.length} slash commands for guild ${process.env.GUILD_ID}.`);
})();
