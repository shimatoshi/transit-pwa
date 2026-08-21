#!/usr/bin/env node
/* qa_through.js — 私鉄同士の直通運転が「乗換0」で引けるか、始発・終電が妥当かを見る。
 *
 * router_v3 は through_service.json を使わない(あれは旧 router.js 用の設定で、
 * v3 は同一 trip が路線をまたぐかどうかを実データから見る)。直通が正しく
 * 取り込めていれば、直通区間のODは transfers=0 で出るはず。
 */
'use strict';
const fs = require('fs');
const R = require('./router_v3.js');
const graph = JSON.parse(fs.readFileSync(__dirname + '/graph_v2.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync(__dirname + '/trains_v3_meta.json', 'utf8'));
const fares = JSON.parse(fs.readFileSync(__dirname + '/fares.json', 'utf8'));
const buf = fs.readFileSync(__dirname + '/trains_v3.bin');
R.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta, graph.stations, fares);
const S = graph.stations;
const strip = s => s.replace(/[（(].*?[）)]/g, '');
function idsOf(name) {
  const exact = [], loose = [];
  for (let i = 0; i < S.length; i++) {
    if (S[i].n === name) exact.push(i); else if (strip(S[i].n) === strip(name)) loose.push(i);
  }
  const rail = a => a.filter(i => !S[i].m);
  for (const c of [rail(exact), rail(loose), exact, loose]) if (c.length) return c;
  return [];
}
const fmt = t => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

// 直通運転で「乗換なし」が期待されるOD
const THROUGH = [
  ['和光市', '渋谷', '東京メトロ副都心線⇄東武東上線'],
  ['小手指', '新木場', '西武池袋線⇄有楽町線'],
  ['海老名', '大手町', '相鉄本線⇄東急⇄都営三田/南北 (2023開業)'],
  ['湘南台', '新横浜', '相鉄いずみ野線⇄相鉄新横浜線'],
  ['中央林間', '久喜', '東急田園都市線⇄半蔵門線⇄東武伊勢崎線'],
  ['元町・中華街', '所沢', 'みなとみらい線⇄東横線⇄副都心線⇄西武池袋線'],
  ['羽田空港第１・第２ターミナル(京急)', '成田空港', '京急⇄都営浅草線⇄京成(空港間直通)'],
  ['三崎口', '青砥', '京急久里浜線⇄都営浅草線⇄京成'],
  ['本厚木', '北千住', '小田急⇄千代田線'],
  ['唐木田', '大手町', '小田急多摩線⇄千代田線'],
  ['奈良', '神戸三宮', '近鉄奈良線⇄阪神なんば線'],
  ['京都', '奈良', 'JR奈良線'],
  ['豊田市', '上小田井', '名鉄豊田線⇄名古屋市営鶴舞線'],
  ['西高島平', '日吉', '都営三田線⇄東急目黒線'],
  ['浦和美園', '日吉', '埼玉高速⇄南北線⇄東急目黒線'],
];

console.log('=== 直通運転(乗換0で引けるか) ===');
for (const [a, b, note] of THROUGH) {
  const ss = idsOf(a), gg = idsOf(b);
  if (!ss.length || !gg.length) { console.log(`  ✗ ${a}→${b}: 駅なし(${!ss.length ? a : b})`); continue; }
  let best = null;
  for (const s of ss) for (const g of gg) {
    if (s === g) continue;
    for (const j of R.findJourneys(s, g, 600, { day: 0 })) {
      if (!best || j.transfers < best.transfers || (j.transfers === best.transfers && j.arr < best.arr)) best = j;
    }
  }
  if (!best) { console.log(`  ✗ ${a}→${b}: 経路なし  (${note})`); continue; }
  const legs = best.legs.filter(l => l.kind === 'ride');
  const mark = best.transfers === 0 ? '○ 直通' : `△ 乗換${best.transfers}`;
  console.log(`  ${mark} ${a}→${b} ${fmt(best.dep)}→${fmt(best.arr)} ${best.arr - best.dep}分  (${note})`);
  console.log(`      ${legs.map(l => `${l.lineLabel || l.line}[${l.type}]`).join(' / ')}`);
}

// --- 始発・終電 ---
console.log('\n=== 主要駅の始発/終発(平日・鉄道) ===');
for (const n of ['東京', '新宿', '大阪', '名古屋', '博多', '札幌(ＪＲ)', '仙台', '広島', '高松(香川)', '那覇']) {
  const ids = idsOf(n);
  if (!ids.length) { console.log(`  ✗ ${n}: 駅なし`); continue; }
  let mn = Infinity, mx = -Infinity, cnt = 0;
  for (const i of ids) {
    for (const d of R.timetable(i, { day: 0 }) || []) {
      cnt++; if (d.dep < mn) mn = d.dep; if (d.dep > mx) mx = d.dep;
    }
  }
  console.log(`  ${n.padEnd(12)} 始発 ${cnt ? fmt(mn) : '—'} / 終発 ${cnt ? fmt(mx) : '—'}  (${cnt}本)`);
}

// --- 早朝・深夜のOD ---
console.log('\n=== 早朝(05:00)/深夜(23:30) に経路が出るか ===');
for (const [a, b] of [['東京', '横浜'], ['新宿', '八王子'], ['大阪', '京都'], ['名古屋', '岐阜'],
                      ['博多', '小倉'], ['渋谷', '池袋'], ['上野', '大宮'], ['仙台', '福島']]) {
  const ss = idsOf(a), gg = idsOf(b);
  const line = [];
  for (const at of [300, 1410]) {
    let best = null;
    for (const s of ss) for (const g of gg) {
      if (s === g) continue;
      for (const j of R.findJourneys(s, g, at, { day: 0 })) if (!best || j.arr < best.arr) best = j;
    }
    line.push(best ? `${fmt(best.dep)}→${fmt(best.arr)}(${best.arr - best.dep}分)` : '経路なし');
  }
  console.log(`  ${a}→${b}  05:00発: ${line[0]}   23:30発: ${line[1]}`);
}
