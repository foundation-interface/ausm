#!/usr/bin/env node
// Keeps the SKILL.md copy embedded in docs/index.html identical to skills/ausm/SKILL.md.
//   node scripts/sync-docs-skill.mjs          rewrite docs/index.html from SKILL.md
//   node scripts/sync-docs-skill.mjs --check  exit 1 if they differ (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pagePath = join(root, 'docs/index.html');
const skillPath = join(root, 'skills/ausm/SKILL.md');

const page = readFileSync(pagePath, 'utf8');
const skill = readFileSync(skillPath, 'utf8');
if (skill.includes('</script')) {
  console.error('SKILL.md contains "</script", which would break the embedded copy.');
  process.exit(1);
}

const re = /(<script type="text\/plain" id="skill-src">\n?)([\s\S]*?)(<\/script>)/;
const m = page.match(re);
if (!m) {
  console.error('docs/index.html: <script id="skill-src"> block not found.');
  process.exit(1);
}

const want = skill.endsWith('\n') ? skill : skill + '\n';
if (process.argv.includes('--check')) {
  if (m[2] !== want) {
    console.error('docs/index.html is out of date with skills/ausm/SKILL.md.\nRun: node scripts/sync-docs-skill.mjs');
    process.exit(1);
  }
  console.log('docs/index.html matches skills/ausm/SKILL.md');
} else if (m[2] === want) {
  console.log('Already in sync.');
} else {
  writeFileSync(pagePath, page.replace(re, (_, a, _b, c) => a + want + c));
  console.log('Updated docs/index.html from skills/ausm/SKILL.md');
}
