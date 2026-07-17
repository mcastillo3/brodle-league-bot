# Wordle League Bot

Discord bot that reads NYT Wordle share posts, stores scores in Firestore, and runs a
weekly Mon–Sun league with an automatic champion announcement every Monday at 4:00 AM.

## How it works

- Players paste their NYT share snippet (`Wordle 1,854 3/6 ...`) into the Wordle channel.
- The bot parses the first line, saves the score, and reacts ✅ (or 🔁 for a repost/correction).
- The week a score belongs to is derived from the **puzzle number**, not the post time —
  Wordle #0 was June 19, 2021, so every puzzle maps to an exact date. Posting Sunday's
  puzzle at 2 AM Monday still counts for the right week.
- `X/6` counts as 7. Skipped days also count as 7 in the weekly ranking (configurable).
- Every Monday 4:00 AM (league timezone) the bot announces the previous week's champion,
  posts final standings, and permanently records the result in the `weeks` collection.

## Setup — step by step

### Part 1: Create the Discord application
1. Go to https://discord.com/developers/applications → **New Application** → name it.
2. Copy the **Application ID** from General Information → this is `CLIENT_ID`.
3. Go to **Bot** (left sidebar) → **Reset Token** → copy it → this is `DISCORD_TOKEN`.
4. Still on the Bot page, scroll to **Privileged Gateway Intents** and enable
   **MESSAGE CONTENT INTENT**. Without this the bot cannot read the pasted scores.
5. Invite the bot: go to **OAuth2 → URL Generator**, check scopes `bot` and
   `applications.commands`; under Bot Permissions check **View Channels**,
   **Send Messages**, **Embed Links**, **Add Reactions**, **Read Message History**.
   Open the generated URL, pick your server, authorize.

### Part 2: Get the IDs
6. In Discord: Settings → Advanced → enable **Developer Mode**.
7. Right-click your server icon → Copy Server ID → `GUILD_ID`.
8. Right-click the channel where scores are posted → Copy Channel ID → `WORDLE_CHANNEL_ID`.
9. Same for the announcement channel → `ANNOUNCE_CHANNEL_ID` (can be the same channel).

### Part 3: Firebase
10. https://console.firebase.google.com → create (or reuse) a project → enable
    **Firestore Database** (production mode is fine; the bot uses the Admin SDK which
    bypasses security rules).
11. Project Settings → **Service accounts** → **Generate new private key** → save the
    file as `serviceAccountKey.json` in the project root (next to `package.json`).

### Part 4: Run it
12. Install Node.js 18+ if needed, then:
    ```bash
    npm install
    cp .env.example .env     # then fill in every value
    npm run deploy           # registers the slash commands (run once)
    npm start
    ```
13. Paste a Wordle share in the channel — the bot should react ✅ within a second.
14. Try `/week`.

## Commands

| Command | What it shows |
|---|---|
| `/week` | Current week standings (lowest total wins, missed days = 7) |
| `/month` | Current calendar month, ranked by average |
| `/alltime` | All-time averages + weekly title counts |
| `/player [user]` | One player's games, average, best, fails, guess distribution |

## Firestore layout

```
scores/{puzzle}_{userId}   userId, username, puzzle, score, failed, hardMode, weekId, monthId
weeks/{weekId}             standings[], winnerIds[], announcedAt
```

Reposting the same puzzle overwrites the previous score (doc ID is `puzzle_userId`),
so corrections are automatic and nobody can double-submit.

## Configuration knobs (.env)

- `TIMEZONE` — cron schedule + "today's puzzle" math (default `America/Chicago`)
- `FAIL_SCORE` — points for X/6 (default 7)
- `MISSED_SCORE` — points per skipped puzzle in weekly ranking (default 7).
  Set to `0` to rank weeks by average of played games instead.

## Keeping it running

The bot must stay online to catch messages and fire the Monday cron. Options:
- A $4–6/mo VPS (Hetzner, DigitalOcean) with `pm2`: `pm2 start src/index.js --name wordle-bot && pm2 save`
- Railway / Render background worker
- A Raspberry Pi on your shelf

If the bot is offline during the Monday 4 AM window, run announcements manually on
restart or just wait — the announcement is idempotent (it checks `weeks/{weekId}`
before posting), so you can safely trigger `announceLastWeek()` any time.
