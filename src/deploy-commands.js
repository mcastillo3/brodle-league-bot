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
].map((c) => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands },
  );
  console.log(`Registered ${commands.length} slash commands for guild ${process.env.GUILD_ID}.`);
})();
