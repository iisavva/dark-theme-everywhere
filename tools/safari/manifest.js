#!/usr/bin/env node
/*
 * Writes the Safari variant of manifest.json.
 * Usage: node tools/safari/manifest.js <source manifest.json> <target manifest.json>
 *
 * Differences from the Chrome/Firefox manifest:
 *  - background: only the service worker (Safari 16.4+); the Firefox "scripts" fallback is removed,
 *    so Safari does not have to choose between two background definitions;
 *  - browser_specific_settings (Firefox only) is removed;
 *  - match_about_blank is removed from content scripts (not supported by Safari, it only warns).
 */
'use strict';

const fs = require('fs');

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: manifest.js <source> <target>');
  process.exit(2);
}

const m = JSON.parse(fs.readFileSync(src, 'utf8'));

m.background = { service_worker: m.background.service_worker };
delete m.browser_specific_settings;
for (const cs of m.content_scripts || []) delete cs.match_about_blank;

fs.writeFileSync(dst, JSON.stringify(m, null, 2) + '\n');
console.log('Safari manifest:', dst);
