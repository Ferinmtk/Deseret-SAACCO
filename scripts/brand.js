// Generates the logo files in public/img/brand from one set of colours.
// The mark is a vector redraw of the SACCO's logo from its member-engagement poster:
// a navy hexagon holding a gold beehive, with a gold arrow rising out of it.
// Change BRAND below and run `node scripts/brand.js` to recolour every file (needs ImageMagick).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BRAND = {
  navy: '#0a2030',
  navyLight: '#1b3a52', // hexagon on dark backgrounds, so it stays visible against navy
  gold: '#c68d3e',
  goldLight: '#e3b45a',
  goldDark: '#a8712a',
};
const out = path.join(__dirname, '..', 'public', 'img', 'brand');
fs.mkdirSync(out, { recursive: true });

// Shapes traced from the poster, in a 120 × 100 box.
const HEX = '47.3,4.6 88.4,25.9 88.4,69.5 47.3,92.5 6.5,71.2 6.5,25.9';
const STRIPES = [
  'M27.8 28.1 C31.5 18.5 39.5 14.4 47.3 14.4 C55.1 14.4 63.1 18.5 66.8 28.1 Z',
  'M18.5 35.2 H76.8 V46.3 H15.7 Q16.3 39.8 18.5 35.2 Z',
  'M10.2 54.6 H62 V64.8 H10.2 Z',
];

// The arrow: a thick zig-zag line with a pointed tail and a triangular head.
const SHAFT = '14,85 30,71 48.1,54.2 61.5,61 94,29.5';
const SHAFT_WIDTH = 8;
const TAIL = '5.6,92.5 16.6,88 11.4,82';
const HEAD = '108.5,10.5 87.5,21.5 103.5,35.5';

function mark({ hexFill, outline, flat }) {
  const gold = flat || 'url(#gold)';
  const defs = flat ? '' : `<defs><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${BRAND.goldLight}"/><stop offset=".55" stop-color="${BRAND.gold}"/><stop offset="1" stop-color="${BRAND.goldDark}"/></linearGradient>` +
    `<clipPath id="hex"><polygon points="${HEX}"/></clipPath></defs>`;
  const clip = flat ? '' : ' clip-path="url(#hex)"';
  const arrow = (fill, stroke, extra) =>
    `<polyline points="${SHAFT}" fill="none" stroke="${stroke}" stroke-width="${SHAFT_WIDTH + extra}" stroke-linejoin="miter" stroke-miterlimit="8"/>` +
    `<polygon points="${TAIL}" fill="${fill}" stroke="${stroke === fill ? 'none' : stroke}" stroke-width="${extra}" stroke-linejoin="round"/>` +
    `<polygon points="${HEAD}" fill="${fill}" stroke="${stroke === fill ? 'none' : stroke}" stroke-width="${extra}" stroke-linejoin="round"/>`;
  return defs +
    `<polygon points="${HEX}" fill="${hexFill}"/>` +
    `<g${clip} fill="${gold}">${STRIPES.map(d => `<path d="${d}"/>`).join('')}</g>` +
    arrow(outline, outline, 2.6) + arrow(gold, gold, 0);
}
const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
const BOX = '0 0 120 100';

const files = {
  // For light backgrounds (as on the poster)
  'logo-mark.svg': svg(BOX, mark({ hexFill: BRAND.navy, outline: '#ffffff' })),
  // For navy or dark backgrounds: a lighter navy hexagon so the shape doesn't disappear
  'logo-mark-reverse.svg': svg(BOX, mark({ hexFill: BRAND.navyLight, outline: BRAND.navy })),
  // One colour, for rubber stamps, photocopies and forms (hexagon outline, solid shapes)
  'logo-mark-mono.svg': svg(BOX, mark({ hexFill: '#ffffff', outline: '#ffffff', flat: BRAND.navy }).replace(
    `<polygon points="${HEX}" fill="#ffffff"/>`, `<polygon points="${HEX}" fill="none" stroke="${BRAND.navy}" stroke-width="5"/>`)),
  // App and phone home-screen icon: the mark on a navy rounded square
  'app-icon.svg': svg('0 0 100 100', `<rect width="100" height="100" rx="22" fill="${BRAND.navy}"/>` +
    `<g transform="translate(8 15) scale(0.72)">${mark({ hexFill: BRAND.navyLight, outline: BRAND.navy })}</g>`),
};
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(out, name), content);

const png = (src, size, name) =>
  execFileSync('magick', ['-background', 'none', '-density', '1200', path.join(out, src), '-resize', `${size}x${size}`, '-gravity', 'center', '-extent', `${size}x${size}`, path.join(out, name)]);
png('app-icon.svg', 180, 'apple-touch-icon.png');
png('app-icon.svg', 192, 'icon-192.png');
png('app-icon.svg', 512, 'icon-512.png');
png('logo-mark.svg', 32, 'favicon-32.png');
execFileSync('magick', ['-background', 'none', '-density', '1200', path.join(out, 'logo-mark.svg'), '-resize', '48x48', '-gravity', 'center', '-extent', '48x48', '-define', 'icon:auto-resize=48,32,16', path.join(out, 'favicon.ico')]);
console.log('Brand files written to', path.relative(process.cwd(), out));
