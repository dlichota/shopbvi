/**
 * Generates the PWA icon set from inline SVG sources.
 * Run manually after changing the mark: `node scripts/generate-icons.mjs`
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// require() honours NODE_PATH, so this resolves against a local `npm i sharp`
// or a globally installed copy.
const sharp = createRequire(import.meta.url)('sharp');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'icons');

const TEAL = '#01696f';
const CREAM = '#f9f8f4';

const glyph = (stroke) => `
  <g fill="none" stroke="${CREAM}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    <rect x="128" y="96" width="256" height="320" rx="22"/>
    <path d="M192 96v320"/>
    <path d="M256 171h64M256 256h64M256 341h64"/>
  </g>`;

// Standard icon: rounded-square mark, safe on any launcher that does not mask.
const standard = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${TEAL}"/>
  ${glyph(28)}
</svg>`;

// Maskable icon: full-bleed background, mark shrunk into the 80% safe zone.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${TEAL}"/>
  <g transform="translate(256 256) scale(0.62) translate(-256 -256)">${glyph(32)}</g>
</svg>`;

// Apple home screen icons are masked to a squircle and never transparent.
const apple = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${TEAL}"/>
  <g transform="translate(256 256) scale(0.78) translate(-256 -256)">${glyph(30)}</g>
</svg>`;

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${TEAL}"/>
  <g fill="none" stroke="${CREAM}" stroke-width="40" stroke-linecap="round" stroke-linejoin="round">
    <rect x="128" y="96" width="256" height="320" rx="24"/>
    <path d="M192 96v320"/>
    <path d="M262 256h56"/>
  </g>
</svg>`;

const targets = [
  { svg: standard, size: 192, file: 'icon-192.png' },
  { svg: standard, size: 512, file: 'icon-512.png' },
  { svg: maskable, size: 192, file: 'icon-maskable-192.png' },
  { svg: maskable, size: 512, file: 'icon-maskable-512.png' },
  { svg: apple, size: 180, file: 'apple-touch-icon.png' },
  { svg: favicon, size: 32, file: 'favicon-32.png' },
];

await mkdir(iconsDir, { recursive: true });
await writeFile(join(iconsDir, 'favicon.svg'), favicon.trim() + '\n');

for (const { svg, size, file } of targets) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(iconsDir, file));
  console.log(`wrote icons/${file} (${size}×${size})`);
}
