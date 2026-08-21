#!/usr/bin/env node
/* qa_calfix_check.js — 運転日タグの「取りこぼし」と「本当に平日のみ」を切り分ける
 *
 * tag_calendar.py は daytype_keys.json に載っていない列車を cal=1(平日のみ) にする。
 * 再スクレイプが届かなかった路線は「全便が平日のみ」に化けて、土日に路線ごと消える。
 * 実際に平日限定の列車(通勤ライナー等)は路線内で一部に留まるはずなので、
 * 「路線内の休日タグ率」の分布を見れば取りこぼしと実態を切り分けられる。
 */
'use strict';
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(__dirname + '/trains_v3_meta.json', 'utf8'));
const cal = m.trips.c, lineOf = m.trips.l, modeOf = m.trips.m;

const per = new Map();
for (let t = 0; t < cal.length; t++) {
  if (modeOf && modeOf[t] === 1) continue;                 // 鉄道のみ
  const n = m.lines[lineOf[t]];
  let p = per.get(n); if (!p) per.set(n, p = { tot: 0, sa: 0, ho: 0 });
  p.tot++; if (cal[t] & 2) p.sa++; if (cal[t] & 4) p.ho++;
}

const buckets = [[0, 0.001, '休日率 0%（=再スクレイプ未達の疑い）'], [0.001, 0.2, '0〜20%'],
                 [0.2, 0.5, '20〜50%'], [0.5, 0.8, '50〜80%'], [0.8, 1.001, '80〜100%（正常）']];
const counts = buckets.map(() => ({ lines: 0, trips: 0 }));
for (const [, p] of per) {
  const r = p.ho / p.tot;
  const b = buckets.findIndex(([lo, hi]) => r >= lo && r < hi);
  counts[b].lines++; counts[b].trips += p.tot;
}
console.log('=== 路線ごとの「休日タグが付いた便の割合」分布 (鉄道路線のみ) ===');
buckets.forEach(([, , lbl], i) => console.log(`  ${lbl.padEnd(34)} 路線${String(counts[i].lines).padStart(4)}  列車${counts[i].trips}本`));

const zero = [...per].filter(([, p]) => p.ho === 0).sort((a, b) => b[1].tot - a[1].tot);
console.log(`\n休日便0本の鉄道路線: ${zero.length}路線 / 影響列車 ${zero.reduce((a, [, p]) => a + p.tot, 0)}本`);
const low = [...per].filter(([, p]) => p.ho > 0 && p.ho / p.tot < 0.2).sort((a, b) => a[1].ho / a[1].tot - b[1].ho / b[1].tot);
console.log(`\n=== 休日率が 0%超20%未満の路線(部分的な取りこぼし疑い): ${low.length} ===`);
low.slice(0, 25).forEach(([n, p]) => console.log(`  ${n}  計${p.tot} 土${p.sa} 休${p.ho} (${(p.ho / p.tot * 100).toFixed(1)}%)`));
