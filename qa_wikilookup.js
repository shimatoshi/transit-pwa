#!/usr/bin/env node
/* qa_wikilookup.js 駅名... — wikidata_stations.json から同名駅の候補を全部出す(調査用) */
'use strict';
const fs = require('fs');
const w = JSON.parse(fs.readFileSync(__dirname + '/wikidata_stations.json', 'utf8'));
const st = Object.values(w.stations);
const base = s => s.replace(/[（(].*?[）)]/g, '').replace(/(駅|停留場|電停)$/, '');
for (const q of process.argv.slice(2)) {
  const b = base(q);
  const hit = st.filter(s => base(s.name) === b);
  console.log(`\n### ${q}  → ${hit.length}件`);
  hit.forEach(s => console.log(`  ${s.name}  (${s.lat},${s.lon})  ${(s.lines || []).join(',')}`));
}
