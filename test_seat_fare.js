#!/usr/bin/env node
/* test_seat_fare.js — 指定席/自由席の特急料金差の検証。
 * 各行: [from, to, 種別ヒント, 期待指定席料金, 期待自由席料金 or null(全車指定席)]
 * 期待値は各社公式の通常期特急料金(2026-06時点)。fares.json は自由席を
 * 「指定席からの控除額」で持つので、ここでは両席種の絶対額を突き合わせる。
 * 判定は本プロジェクトの精度方針にあわせ ±300円。
 */
'use strict';
const fs = require('fs');
const R = require('./router_v3.js');
const graph = JSON.parse(fs.readFileSync('graph_v2.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('trains_v3_meta.json', 'utf8'));
const fares = JSON.parse(fs.readFileSync('fares.json', 'utf8'));
const buf = fs.readFileSync('trains_v3.bin');
R.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta, graph.stations, fares);

// 全ての OD が鉄道駅なので鉄道側だけを引く。バス停には「長野(和歌山県)」のように
// 鉄道駅と同名のものが全国にあり、素の名前一致だとそちらを掴む
const id = n => {
  const strip = s => s.replace(/[（(].*?[）)]/g, '');
  const rail = graph.stations.map((s, i) => [s, i]).filter(([s]) => !s.m);
  let e = rail.find(([s]) => s.n === n);
  if (!e) e = rail.find(([s]) => strip(s.n) === strip(n));
  return e ? e[1] : -1;
};
const exSum = fr => fr.breakdown.filter(b => /料金/.test(b.company)).reduce((a, b) => a + b.fare, 0);

// [from, to, ヒント種別, 指定席, 自由席(nullなら自由席の設定なし=席種選択不可)]
const ANCHORS = [
  ['東京', '新大阪', 'のぞみ', 5810, 4960],
  ['東京', '名古屋', 'のぞみ', 4830, 4180],
  ['東京', '広島',   'のぞみ', 7420, 6500],
  ['新大阪', '博多', 'のぞみ', 5810, 4960],
  ['博多', '鹿児島中央', 'みずほ', 4940, 4400],
  ['東京', '新潟',   'とき',   4950, 4420],
  ['東京', '長野',   'あさま', 4200, 3670],
  ['東京', '仙台',   'はやぶさ', 5480, null],   // はやぶさ=全車指定席
  ['東京', '秋田',   'こまち', 7970, null],     // こまち=全車指定席
  ['東京', '金沢',   'かがやき', 6780, null],   // かがやき=全車指定席
  ['新宿', '松本',   'あずさ', 3070, null],     // あずさ=全車指定席
  ['新宿', '甲府',   'かいじ', 2390, null],     // かいじ=全車指定席
];

let fail = 0;
for (const [f, t, hint, expR, expN] of ANCHORS) {
  const s = id(f), g = id(t);
  if (s < 0 || g < 0) { console.log(`✗ ${f}→${t}: 駅なし`); fail++; continue; }
  let chosen = null;
  for (const at of [480, 540, 600, 660, 720]) {
    for (const j of R.findJourneys(s, g, at, {})) {
      if (j.legs.some(l => l.kind === 'ride' && (l.type || '').includes(hint))) { chosen = j; break; }
    }
    if (chosen) break;
  }
  if (!chosen) { console.log(`✗ ${f}→${t}: ${hint}経路なし`); fail++; continue; }

  const frR = R.journeyFare(chosen, { seat: 'reserved' });
  const frN = R.journeyFare(chosen, { seat: 'nonreserved' });
  const gotR = exSum(frR), gotN = exSum(frN);
  const why = [];
  if (Math.abs(gotR - expR) > 300) why.push(`指定${gotR}≠${expR}`);
  if (expN == null) {
    // 全車指定席: 自由席を要求しても料金は変わらず、席種選択も提示しない
    if (gotN !== gotR) why.push(`自由席なしのはずが${gotN}`);
    if (frR.seatFares) why.push('席種選択が出ている');
  } else {
    if (Math.abs(gotN - expN) > 300) why.push(`自由${gotN}≠${expN}`);
    if (!frR.seatFares) why.push('席種選択が出ていない');
    else if (frR.seatFares.reserved - frR.seatFares.nonreserved !== gotR - gotN) why.push('seatFaresが内訳と不一致');
    if (frR.total - frN.total !== gotR - gotN) why.push('総額差が特急料金差と不一致');
  }
  const ok = why.length === 0;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${f}→${t} [${hint}]  指定${gotR}(期待${expR}) / 自由${expN == null ? '—(全車指定席)' : gotN + '(期待' + expN + ')'}` +
              `  総額 指定¥${frR.total} 自由¥${frN.total}${why.length ? '  [' + why.join(', ') + ']' : ''}`);
}
console.log(fail === 0 ? '\nALL OK' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
