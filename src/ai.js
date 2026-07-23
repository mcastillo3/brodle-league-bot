/**
 * Optional AI-generated roast/fortune lines.
 *
 * Works with ANY OpenAI-compatible chat endpoint, so you can swap providers
 * without code changes if a free tier disappears. Set in .env:
 *
 *   AI_API_KEY=...            (required to enable; without it, nothing happens)
 *   AI_BASE_URL=...           (default: Groq)
 *   AI_MODEL=...              (default: llama-3.3-70b-versatile)
 *
 * Known-good free options (no credit card):
 *   Groq    https://api.groq.com/openai/v1        llama-3.3-70b-versatile
 *   Gemini  https://generativelanguage.googleapis.com/v1beta/openai
 *                                                 gemini-2.5-flash
 *   Cerebras https://api.cerebras.ai/v1           llama-3.3-70b
 *
 * EVERY function here returns null on any failure (no key, rate limit, timeout,
 * bad response). Callers fall back to the hardcoded lines in fun.js, so the bot
 * keeps working exactly as before if the API is unavailable.
 */

const fun = require('./fun');

const BASE_URL = process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1';
const MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';
const API_KEY = process.env.AI_API_KEY;
const TIMEOUT_MS = 8000;

const enabled = () => Boolean(API_KEY);

/** Low-level call. Returns trimmed text, or null on any problem. */
async function chat(system, user, { temperature = 1.05, maxTokens = 120 } = {}) {
  if (!enabled()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[ai] ${res.status} ${res.statusText} — falling back to canned line`);
      return null;
    }
    const data = await res.json();
    let text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    // Strip surrounding quotes some models add, and collapse to one line.
    text = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s*\n+\s*/g, ' ').trim();
    if (text.length > 300) text = text.slice(0, 297) + '...';
    return text || null;
  } catch (err) {
    console.error('[ai] request failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Compact, factual stat line so the model has real material to work with. */
function statsFacts(name, stats) {
  const bits = [
    `player: ${name}`,
    `games played: ${stats.games}`,
    `lifetime average guesses: ${stats.avg?.toFixed(2)}`,
    `failed puzzles: ${stats.fails}`,
    `solved in 1 guess: ${stats.aces}`,
    `solved in 2: ${stats.twos}`,
    `last-guess (6/6) escapes: ${stats.sixes}`,
  ];
  const worstDay = fun.worstWeekday(stats);
  const bestDay = fun.bestWeekday(stats);
  const worstMonth = fun.worstMonth(stats);
  if (worstDay) bits.push(`worst weekday: ${worstDay.day} (${worstDay.avg.toFixed(2)} avg)`);
  if (bestDay) bits.push(`best weekday: ${bestDay.day} (${bestDay.avg.toFixed(2)} avg)`);
  if (worstMonth) bits.push(`worst month on record: ${worstMonth.month} (${worstMonth.avg.toFixed(2)} avg)`);
  return bits.join('\n');
}

const ROAST_SYSTEM = `You write one-line roasts for a private Wordle league played by a group of longtime friends. The tone is savage locker-room trash talk between friends who enjoy giving each other hell.

RULES — follow all of them:
- Roast their Wordle performance using ONLY the stats provided. Never invent a statistic.
- You may mock the player directly, but ONLY in the context of their Wordle results. Every joke must be clearly tied to the numbers.
- Be sharp, sarcastic, and brutal. Lean into choke jobs, terrible averages, lucky flukes, blown streaks, wasted guesses, inconsistency, and chronic mediocrity.
- The roast should feel earned by the stats. Better numbers deserve lighter shots; awful numbers deserve ruthless ones.
- No references to appearance, weight, health, disability, race, ethnicity, nationality, religion, politics, gender, sexuality, family, relationships, job, or finances.
- Profanity is allowed when it improves the joke. No slurs.
- Avoid generic insults that could apply to anyone; make the joke specific to the provided stats.
- Prefer punchlines that compare their performance to embarrassment, failure, incompetence, or being a burden to the league.
- PRIORITY: if a "TODAY'S SCORE" line is present, lead with that. If not, lead with "THIS WEEK" performance. Weave in their record on today's weekday and lifetime stats as supporting ammo.
- The score is 1 being the best and 6 being the worst. So the higher the score, the worse.
- 1 to 2 sentences, under 200 characters total.
- Output ONLY the roast text. No preamble, no quotation marks, no emoji.`;

const FORTUNE_SYSTEM = `You write whimsical daily "Wordle fortunes" for a private Wordle league — a fortune cookie crossed with a horoscope, for a word game.

RULES — follow all of them:
- Use the player's real stats to make it feel personal and specific, but keep it mystical and playful.
- Never mean-spirited or discouraging. Wry, ominous-but-fun, or encouraging are all good.
- Nothing about appearance, family, health, work, religion, politics, or any personal characteristic. Wordle only.
- Vary your imagery — tiles, vowels, guesses, streaks, the dictionary, fate, omens.
- 1 to 2 sentences, under 200 characters total.
- Begin with a single fitting emoji, then the fortune. Output ONLY that line, no quotation marks.`;

/** AI roast, or null to fall back. `context` is a caller-built fact block. */
async function roast(name, context) {
  return chat(ROAST_SYSTEM, `Roast this player:\n\n${context}`);
}

/** AI fortune for today, or null to fall back. */
async function fortune(name, stats, weekdayName) {
  const user = `Write today's fortune. Today is ${weekdayName}.\n\n${statsFacts(name, stats)}`;
  return chat(FORTUNE_SYSTEM, user);
}

module.exports = { enabled, roast, fortune, chat };
