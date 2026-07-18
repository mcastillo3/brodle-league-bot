/**
 * Theme definitions for the weekly champion's chosen look.
 *
 * The champion picks TWO named colors (rows alternate between them) and one
 * preset emoji (shown over their initials in /week). Choices are stored in
 * Firestore (meta/theme) and read by the /week renderer.
 */

// Named colors -> hex. Kept to a friendly, unambiguous set. Add freely.
const COLORS = {
  green:   '#C0DD97',
  teal:    '#9FE1CB',
  mint:    '#5DCAA5',
  blue:    '#B5D4F4',
  sky:     '#85B7EB',
  purple:  '#CECBF6',
  lavender:'#AFA9EC',
  pink:    '#F4C0D1',
  rose:    '#ED93B1',
  red:     '#F7C1C1',
  coral:   '#F5C4B3',
  orange:  '#FAC775',
  amber:   '#EF9F27',
  yellow:  '#FAEEDA',
  gray:    '#D3D1C7',
  slate:   '#B4B2A9',
  cream:   '#F1EFE8',
  white:   '#FFFFFF',
};

// Preset champion emojis the winner can choose from.
const EMOJIS = {
  crown:    '👑',
  star:     '⭐',
  fire:     '🔥',
  goat:     '🐐',
  trophy:   '🏆',
  medal:    '🥇',
  brain:    '🧠',
  rocket:   '🚀',
  sparkles: '✨',
  bolt:     '⚡',
  cherry:   '🍒',
  crystal:  '🔮',
  chili:    '🌶️',
  muscle:   '💪',
  clown:    '🤡',
};

// Used until a champion sets a theme (matches the original look).
const DEFAULT_THEME = {
  colorA: 'green',
  colorB: 'cream',
  emoji: 'crown',
  championId: null,
};

const colorHex = (name) => COLORS[String(name).toLowerCase()] || null;
const emojiChar = (name) => EMOJIS[String(name).toLowerCase()] || null;
const colorNames = () => Object.keys(COLORS);
const emojiNames = () => Object.keys(EMOJIS);

module.exports = {
  COLORS, EMOJIS, DEFAULT_THEME,
  colorHex, emojiChar, colorNames, emojiNames,
};
