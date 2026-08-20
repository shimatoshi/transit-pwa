#!/usr/bin/env node
/* qa_probe.js — 代表駅の存在チェック(路線まるごと欠落の検出) */
'use strict';
const fs = require('fs');
const g = JSON.parse(fs.readFileSync(__dirname + '/graph_v2.json', 'utf8'));
const byName = new Map();
g.stations.forEach((s, i) => {
  if (!byName.has(s.n)) byName.set(s.n, []);
  byName.get(s.n).push(i);
});
const strip = s => s.replace(/[（(].*?[）)]/g, '');
const byStrip = new Map();
g.stations.forEach((s, i) => {
  const k = strip(s.n);
  if (!byStrip.has(k)) byStrip.set(k, []);
  byStrip.get(k).push(i);
});

// 事業者 -> 代表駅(その路線にしか無い駅を選ぶ)
const PROBES = require(__dirname + '/qa_probe_list.json');
const missing = [], found = [];
for (const [operator, stns] of Object.entries(PROBES)) {
  const hits = stns.map(n => {
    const ids = byName.get(n) || byStrip.get(strip(n)) || [];
    return { n, ids };
  });
  const any = hits.filter(h => h.ids.length);
  if (!any.length) {
    missing.push({ operator, stns });
  } else {
    found.push({ operator, hits: any.map(h => `${h.n}→[${h.ids.map(i => (g.stations[i].l || []).join(',')).join(' / ')}]`) });
  }
}
console.log(`=== ★事業者まるごと欠落(代表駅がどれも存在しない): ${missing.length} ===`);
missing.forEach(m => console.log(`  ${m.operator}  (探した駅: ${m.stns.join(' ')})`));
console.log(`\n=== 存在した: ${found.length} ===`);
found.forEach(f => console.log(`  ${f.operator}: ${f.hits.join(' ; ')}`));
