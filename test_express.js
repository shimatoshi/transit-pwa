#!/usr/bin/env node
/* test_express.js — 特急料金(乗車券への加算)の検証。
 * 各行: [from, to, 期待特急料金(指定通常期,円), 列車種別ヒント]
 * findJourneys(express on)で該当列車を使う経路を探し、breakdownの特急料金成分を比較。
 */
'use strict';
const fs = require('fs');
const R = require('./router_v3.js');
const graph = JSON.parse(fs.readFileSync('graph_v2.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('trains_v3_meta.json', 'utf8'));
const fares = JSON.parse(fs.readFileSync('fares.json', 'utf8'));
const buf = fs.readFileSync('trains_v3.bin');
R.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta, graph.stations, fares);

const id = n => {
  const strip = s => s.replace(/[（(].*?[）)]/g, '');
  let i = graph.stations.findIndex(s => s.n === n);
  if (i < 0) i = graph.stations.findIndex(s => strip(s.n) === strip(n));
  return i;
};

// [from, to, 期待特急料金, ヒント種別(この種別を含むlegがある経路を採用)]
const ANCHORS = [
  ['東京', '新大阪', 5810, 'のぞみ'],
  ['東京', '名古屋', 4830, 'のぞみ'],
  ['東京', '広島', 7420, 'のぞみ'],
  ['新大阪', '博多', 5810, 'のぞみ'],
  ['博多', '鹿児島中央', 4940, 'みずほ'],
  ['東京', '仙台', 5270, 'はやぶさ'],
  ['東京', '盛岡', 6340, 'はやぶさ'],
  ['東京', '新青森', 7330, 'はやぶさ'],
  ['東京', '新潟', 4950, 'とき'],
  ['東京', '金沢', 6780, 'かがやき'],
  ['東京', '長野', 4200, 'あさま'],
  ['東京', '秋田', 7970, 'こまち'],
  ['新宿', '甲府', 2390, 'かいじ'],
  ['新宿', '松本', 3070, 'あずさ'],
];

for (const [f, t, exp, hint] of ANCHORS) {
  const s = id(f), g = id(t);
  if (s < 0 || g < 0) { console.log(`${f}→${t}: 駅なし`); continue; }
  let chosen = null;
  for (const at of [480, 540, 600, 660, 720]) {
    const js = R.findJourneys(s, g, at, {});
    for (const j of js) {
      if (j.legs.some(l => l.kind === 'ride' && (l.type || '').includes(hint))) { chosen = j; break; }
    }
    if (chosen) break;
  }
  if (!chosen) { console.log(`${f}→${t}: ${hint}経路なし`); continue; }
  const fr = R.journeyFare(chosen);
  const exFare = fr.breakdown.filter(b => /料金$/.test(b.company)).reduce((a, b) => a + b.fare, 0);
  const diff = exFare - exp;
  const mark = Math.abs(diff) <= 300 ? 'OK ' : '×× ';
  console.log(`${mark}${f}→${t}  特急料金 期待${exp} 算${exFare} 差${diff >= 0 ? '+' : ''}${diff}  総額¥${fr.total}  [${hint}]`);
}
