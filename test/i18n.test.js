/*
 * Checks the interface translations: every language has the same keys as English, every
 * data-i18n key used in the pages exists, and the manifest's __MSG_*__ names are in _locales.
 *
 * Usage: node test/i18n.test.js
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'ui', 'i18n.js'), 'utf8'), ctx);
const { STR } = ctx.I18N;

const errors = [];
const en = Object.keys(STR.en);
for (const lang of Object.keys(STR)) {
  const keys = Object.keys(STR[lang]);
  for (const k of en) if (!keys.includes(k)) errors.push(`${lang}: missing ${k}`);
  for (const k of keys) if (!en.includes(k)) errors.push(`${lang}: extra ${k}`);
  for (const k of keys) if (!String(STR[lang][k]).trim()) errors.push(`${lang}: empty ${k}`);
}

// Keys used in the pages and scripts
const used = new Set();
for (const f of ['popup/popup.html', 'options/options.html']) {
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
}
for (const f of ['popup/popup.js', 'options/options.js', 'src/background.js']) {
  const js = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of js.matchAll(/\bt\('([A-Za-z]+)'/g)) used.add(m[1]);
  for (const m of js.matchAll(/I18N\.t\(([^)]*)\)/g)) for (const q of m[1].matchAll(/'([A-Za-z]+)'/g)) used.add(q[1]);
}
for (const k of used) if (!en.includes(k)) errors.push(`used but not translated: ${k}`);

// Manifest messages
const manifest = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
const msgs = [...manifest.matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
const def = JSON.parse(manifest).default_locale;
if (def !== 'en') errors.push(`default_locale is ${def}, expected en`);
for (const dir of fs.readdirSync(path.join(root, '_locales'))) {
  const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales', dir, 'messages.json'), 'utf8'));
  for (const m of msgs) if (!messages[m] || !messages[m].message) errors.push(`_locales/${dir}: missing ${m}`);
}

if (errors.length) {
  console.log(errors.map((e) => 'FAIL ' + e).join('\n'));
  process.exit(1);
}
console.log(`ok   ${Object.keys(STR).length} languages, ${en.length} keys, ${used.size} used, ${msgs.length} manifest messages`);
