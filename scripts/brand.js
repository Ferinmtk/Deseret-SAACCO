// Generates the logo files in public/img/brand from one set of colours.
// Change BRAND below and run `node scripts/brand.js` to recolour every file.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BRAND = { primary: '#0f5257', dark: '#0a383c', honey: '#d9a21b' };
const out = path.join(__dirname, '..', 'public', 'img', 'brand');
fs.mkdirSync(out, { recursive: true });

// "Growing comb": three honeycomb cells stepping upward, the top one in honey.
const cells = [
  '27,52 43,61 43,79 27,88 11,79 11,61',
  '54,36 70,45 70,63 54,72 38,63 38,45',
  '73,12 89,21 89,39 73,48 57,39 57,21',
];
const mark = (fills, extra = '') =>
  cells.map((pts, i) => `<polygon points="${pts}" fill="${fills[i][0]}"${fills[i][1] ? ` fill-opacity="${fills[i][1]}"` : ''}/>`).join('') + extra;
// Solid tints for dark backgrounds (see-through cells would show darker slivers where they overlap).
const mix = (hex, amount) => '#' + [1, 3, 5].map(i => Math.round(255 * amount + parseInt(hex.slice(i, i + 2), 16) * (1 - amount)).toString(16).padStart(2, '0')).join('');
const reverse = [[mix(BRAND.primary, 0.55)], [mix(BRAND.primary, 0.85)], [BRAND.honey]];
const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

const files = {
  // For light backgrounds
  'logo-mark.svg': svg('8 8 84 84', mark([[BRAND.primary], [BRAND.dark], [BRAND.honey]])),
  // For dark or coloured backgrounds (menu bar, footer, portal sidebar)
  'logo-mark-reverse.svg': svg('8 8 84 84', mark(reverse)),
  // One colour, for rubber stamps, photocopies and forms
  'logo-mark-mono.svg': svg('8 8 84 84', mark([[BRAND.dark], [BRAND.dark], [BRAND.dark]])),
  // App and phone home-screen icon: reverse mark on a primary rounded square
  'app-icon.svg': svg('0 0 100 100', `<rect width="100" height="100" rx="22" fill="${BRAND.primary}"/><g transform="translate(18 18) scale(0.64)">${mark(reverse)}</g>`),
};
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(out, name), content);

// PNG and ICO versions for browsers and phones (needs ImageMagick).
const png = (src, size, name, bg = 'none') =>
  execFileSync('magick', ['-background', bg, '-density', '1200', path.join(out, src), '-resize', `${size}x${size}`, path.join(out, name)]);
png('app-icon.svg', 180, 'apple-touch-icon.png');
png('app-icon.svg', 192, 'icon-192.png');
png('app-icon.svg', 512, 'icon-512.png');
png('logo-mark.svg', 32, 'favicon-32.png');
execFileSync('magick', ['-background', 'none', '-density', '1200', path.join(out, 'logo-mark.svg'), '-define', 'icon:auto-resize=48,32,16', path.join(out, 'favicon.ico')]);
console.log('Brand files written to', path.relative(process.cwd(), out));
