/**
 * Renders league tables as PNG images so they look identical on desktop and
 * mobile. Uses @napi-rs/canvas (prebuilt binaries — no system deps, unlike the
 * older `canvas` package which needs Cairo installed).
 *
 *   npm install @napi-rs/canvas
 *
 * Colors mirror the spreadsheet's conditional formatting: lower (better)
 * scores are greener, higher are amber, fails are red, missed days are gray.
 */

const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');

// Register the fonts we draw with by explicit family name. The bundled files
// in assets/ are tried FIRST so rendering works identically on any host
// (Railway, a Pi, a VPS) with zero system font dependencies. Windows and
// Linux system paths are fallbacks. try/catch so a missing file never crashes.
const ASSET = (f) => path.join(__dirname, '..', 'assets', f);

function tryFont(paths, family) {
  const fs = require('fs');
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) { GlobalFonts.registerFromPath(p, family); return p; }
    } catch { /* ignore and try next */ }
  }
  console.warn(`[fonts] no file found for family ${family} — text may not render`);
}
tryFont([ASSET('DejaVuSans.ttf'), 'C:\\Windows\\Fonts\\segoeui.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'], 'AppSans');
tryFont([ASSET('DejaVuSans-Bold.ttf'), 'C:\\Windows\\Fonts\\segoeuib.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'], 'AppSansBold');
tryFont([ASSET('DejaVuSansMono.ttf'), 'C:\\Windows\\Fonts\\consola.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'], 'AppMono');
tryFont([ASSET('NotoColorEmoji.ttf'), 'C:\\Windows\\Fonts\\seguiemj.ttf', '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'], 'AppEmoji');

// Font stacks used throughout. AppEmoji is appended so glyphs like 👑 ✔️ render.
const SANS = 'AppSans, "Segoe UI", sans-serif, AppEmoji';
const SANS_BOLD = 'AppSansBold, "Segoe UI", sans-serif, AppEmoji';
const MONO = 'AppMono, "Consolas", monospace, AppEmoji';

// score -> {bg, fg}. 1-2 great (teal/green), 3-4 ok (green/pale), 5-6 warm, X red.
const SCORE_COLORS = {
  1: { bg: '#5DCAA5', fg: '#04342C' },
  2: { bg: '#5DCAA5', fg: '#04342C' },
  3: { bg: '#9FE1CB', fg: '#04342C' },
  4: { bg: '#C0DD97', fg: '#173404' },
  5: { bg: '#FAC775', fg: '#412402' },
  6: { bg: '#EF9F27', fg: '#412402' },
  X: { bg: '#F7C1C1', fg: '#501313' },
  miss: { bg: '#E4E2DA', fg: '#888780' },
};

/**
 * @param opts.title      main header line
 * @param opts.subtitle   line under the title
 * @param opts.players    [{ id, label }] in column order
 * @param opts.puzzles    [1850, 1851, ...] visible puzzle numbers (rows)
 * @param opts.cell       (puzzleNumber, playerId) => { score, failed } | null
 * @param opts.footerRows [{ label, values: {playerId: string}, strong? }]
 * @param opts.leader     optional highlighted callout string
 * @param opts.theme      { colorAHex, colorBHex, emojiChar, championId }
 * @param opts.rules      [ "1) ...", "2) ..." ] lines for the rules footer
 * @returns Buffer (PNG)
 */
function renderWeekTable(opts) {
  const {
    title, subtitle, players, puzzles, cell, footerRows = [], leader,
    theme = {}, rules = [],
  } = opts;

  const colorA = theme.colorAHex || '#C0DD97';
  const colorB = theme.colorBHex || '#F1EFE8';
  const champEmoji = theme.emojiChar || null;
  const champId = theme.championId || null;

  // layout
  const rowH = 30, headerH = 40, pad = 20;
  const labelW = 66;
  const colW = Math.max(52, Math.min(84, Math.floor((360 - labelW) / players.length)));
  const width = Math.max(380, labelW + pad * 2 + colW * players.length);
  const titleBlock = 84;              // taller header for the two long text lines
  const gridTop = titleBlock + headerH;
  const bodyRows = puzzles.length;
  const footH = footerRows.length * 26 + 16;
  const leaderH = leader ? 52 : 12;
  const rulesH = rules.length ? rules.length * 22 + 30 : 0;
  const height = gridTop + bodyRows * rowH + footH + leaderH + rulesH + pad;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const mono = `600 13px ${MONO}`;
  const monoR = `13px ${MONO}`;

  // background
  ctx.fillStyle = '#F1EFE8';
  roundRect(ctx, 0, 0, width, height, 14); ctx.fill();

  // title (wraps if too wide) + subtitle
  ctx.fillStyle = '#2C2C2A';
  ctx.font = `600 16px ${SANS_BOLD}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, pad, 32);
  if (subtitle) {
    ctx.fillStyle = '#5F5E5A';
    ctx.font = `italic 12px ${SANS}`;
    wrapText(ctx, subtitle, pad, 52, width - pad * 2, 15);
  }

  const colX = (i) => pad + labelW + i * colW + colW / 2;

  // champion emoji over their column (if the champion is on the board)
  if (champEmoji && champId) {
    const ci = players.findIndex((p) => p.id === champId);
    if (ci >= 0) {
      ctx.font = `16px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText(champEmoji, colX(ci), titleBlock - 4);
    }
  }

  // header (player labels)
  ctx.font = `600 14px ${SANS_BOLD}`;
  ctx.fillStyle = '#2C2C2A';
  ctx.textAlign = 'center';
  players.forEach((p, i) => ctx.fillText(p.label, colX(i), titleBlock + 24));

  // body rows — alternate between the two theme colors (Option 1)
  puzzles.forEach((pz, r) => {
    const y = gridTop + r * rowH;
    const rowBg = r % 2 === 0 ? colorA : colorB;

    // row band spanning the player columns
    ctx.fillStyle = rowBg;
    roundRect(ctx, pad + labelW, y + 2, colW * players.length, rowH - 6, 5); ctx.fill();

    // puzzle number in the left gutter
    ctx.fillStyle = '#5F5E5A';
    ctx.textAlign = 'left';
    ctx.font = monoR;
    ctx.fillText(String(pz), pad, y + 20);

    // scores as plain text on the colored row
    players.forEach((p, i) => {
      const c = cell(pz, p.id);
      ctx.fillStyle = '#2C2C2A';
      ctx.font = mono;
      ctx.textAlign = 'center';
      ctx.fillText(!c ? '·' : (c.failed ? 'X' : String(c.score)), colX(i), y + 20);
    });
  });

  // divider
  let fy = gridTop + bodyRows * rowH + 6;
  ctx.strokeStyle = '#B4B2A9';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, fy); ctx.lineTo(width - pad, fy); ctx.stroke();
  fy += 6;

  // footer rows (pts / avg / seas / all)
  footerRows.forEach((row) => {
    fy += 22;
    ctx.fillStyle = '#2C2C2A';
    ctx.font = row.strong ? mono : monoR;
    ctx.textAlign = 'left';
    ctx.fillText(row.label, pad, fy);
    players.forEach((p, i) => {
      ctx.fillStyle = row.strong ? '#2C2C2A' : '#5F5E5A';
      ctx.textAlign = 'center';
      ctx.fillText(String(row.values[p.id] ?? '·'), colX(i), fy);
    });
  });

  // leader callout
  if (leader) {
    fy += 18;
    ctx.fillStyle = '#EAF3DE';
    roundRect(ctx, pad, fy, width - pad * 2, 38, 8); ctx.fill();
    ctx.fillStyle = '#173404';
    ctx.font = `600 13px ${SANS_BOLD}`;
    ctx.textAlign = 'left';
    ctx.fillText(leader, pad + 14, fy + 24);
    fy += 38;
  }

  // rules footer
  if (rules.length) {
    fy += 26;
    ctx.fillStyle = '#2C2C2A';
    ctx.font = `600 12px ${SANS_BOLD}`;
    ctx.textAlign = 'left';
    ctx.fillText('RULES', pad, fy);
    ctx.font = `12px ${SANS}`;
    ctx.fillStyle = '#5F5E5A';
    rules.forEach((line, i) => ctx.fillText(line, pad, fy + 20 + i * 22));
  }

  return canvas.toBuffer('image/png');
}

/** Draw text, wrapping to the next line if it exceeds maxWidth. */
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      y += lineHeight;
      line = w;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Renders a player-rows summary table as PNG (for /month and /alltime).
 *
 * @param opts.title    e.g. "All-time"
 * @param opts.subtitle e.g. "ranked by average"
 * @param opts.columns  [{ key, header, align }]  align: 'left'|'right' (default right)
 * @param opts.rows     [{ label, cells: {key: string}, highlight?: bool }]
 * @returns Buffer (PNG)
 */
function renderStatsTable(opts) {
  const { title, subtitle, columns, rows } = opts;

  const pad = 20, rowH = 30, headerH = 30, labelW = 56;
  const colW = 62;
  const width = Math.max(360, labelW + pad * 2 + columns.length * colW);
  const titleBlock = 58;
  const gridTop = titleBlock + headerH;
  const height = gridTop + rows.length * rowH + pad;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const mono = `600 13px ${MONO}`;
  const monoR = `13px ${MONO}`;

  ctx.fillStyle = '#F1EFE8';
  roundRect(ctx, 0, 0, width, height, 14); ctx.fill();

  ctx.fillStyle = '#2C2C2A';
  ctx.font = `600 17px ${SANS_BOLD}`;
  ctx.fillText(title, pad, 34);
  if (subtitle) {
    ctx.fillStyle = '#5F5E5A';
    ctx.font = `12px ${SANS}`;
    ctx.fillText(subtitle, pad, 52);
  }

  const colX = (i) => pad + labelW + i * colW + colW - 8; // right-aligned anchor

  // header
  ctx.font = `600 12px ${SANS_BOLD}`;
  ctx.fillStyle = '#5F5E5A';
  ctx.textAlign = 'right';
  columns.forEach((c, i) => ctx.fillText(c.header, colX(i), titleBlock + 20));

  // rows
  rows.forEach((row, r) => {
    const y = gridTop + r * rowH;
    if (row.highlight) {
      ctx.fillStyle = '#EAF3DE';
      roundRect(ctx, pad - 6, y + 2, width - (pad - 6) * 2, rowH - 4, 6); ctx.fill();
    }
    ctx.fillStyle = '#2C2C2A';
    ctx.font = mono;
    ctx.textAlign = 'left';
    ctx.fillText(row.label, pad, y + 20);

    ctx.font = monoR;
    columns.forEach((c, i) => {
      ctx.fillStyle = i === 0 ? '#2C2C2A' : '#5F5E5A';
      ctx.textAlign = 'right';
      ctx.fillText(String(row.cells[c.key] ?? '·'), colX(i), y + 20);
    });
  });

  return canvas.toBuffer('image/png');
}

module.exports = { renderWeekTable, renderStatsTable };
