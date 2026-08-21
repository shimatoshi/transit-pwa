#!/usr/bin/env node
/* qa_airport.js — 空港アクセスと新設路線の収録状況を見る。
 * (1) 空港駅そのものが引けるか  (2) 代表的な都心ODから経路が出るか
 * Usage: node qa_airport.js [stations|routes]
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
    if (S[i].n === name) exact.push(i);
    else if (strip(S[i].n) === strip(name)) loose.push(i);
  }
  const rail = a => a.filter(i => !S[i].m);
  for (const c of [rail(exact), rail(loose), exact, loose]) if (c.length) return c;
  return [];
}
const fmt = t => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

function best(from, to, hh, day) {
  const ss = idsOf(from), gg = idsOf(to);
  if (!ss.length) return { error: `駅なし:${from}` };
  if (!gg.length) return { error: `駅なし:${to}` };
  let out = null;
  for (const s of ss) for (const g of gg) {
    if (s === g) continue;
    for (const j of R.findJourneys(s, g, hh * 60, day == null ? {} : { day })) if (!out || j.arr < out.arr) out = j;
  }
  if (!out) return { error: 'NO_ROUTE' };
  const fr = R.journeyFare(out);
  return { dep: out.dep, arr: out.arr, min: out.arr - out.dep, transfers: out.transfers, fare: fr.total,
           lines: out.legs.filter(l => l.kind === 'ride').map(l => (l.lineLabel || l.line || '').replace(/^ＪＲ/, '')) };
}
const show = r => r.error ? `  ✗ ${r.error}` : `  ${fmt(r.dep)}→${fmt(r.arr)} ${String(r.min).padStart(3)}分 乗換${r.transfers} ¥${r.fare}  ${r.lines.join(' / ')}`;

// --- 空港駅の在否 ---
const AIRPORTS = [
  '成田空港', '空港第2ビル', '羽田空港第1ターミナル', '羽田空港第2ターミナル', '羽田空港第3ターミナル',
  '羽田空港国内線ターミナル', '羽田空港国際線ターミナル',
  '関西空港', '関西国際空港', '大阪空港', '中部国際空港', '新千歳空港', '仙台空港',
  '宮崎空港', '那覇空港', '福岡空港', '広島空港', '松山空港', '高松空港', '鹿児島空港',
];
// --- 近年開業/延伸した路線・駅 ---
const NEW = [
  ['西九州新幹線', ['武雄温泉', '嬉野温泉', '新大村', '諫早', '長崎']],
  ['北陸新幹線 敦賀延伸(2024)', ['福井', '芦原温泉', '越前たけふ', '敦賀', '小松', '加賀温泉']],
  ['相鉄・東急新横浜線(2023)', ['新横浜', '新綱島', '羽沢横浜国大']],
  ['福岡市地下鉄七隈線 延伸(2023)', ['櫛田神社前', '博多']],
  ['宇都宮ライトレール(2023)', ['宇都宮駅東口', '芳賀・高根沢工業団地']],
  ['おおさか東線 全線(2019)', ['新大阪', 'JR淡路', '衣摺加美北', '久宝寺']],
  ['日立市/その他新駅', ['高輪ゲートウェイ', '虎ノ門ヒルズ', '幕張豊砂', 'ネーミングライツ']],
];

const mode = process.argv[2] || 'all';

if (mode === 'all' || mode === 'stations') {
  console.log('=== 空港駅の在否 ===');
  for (const a of AIRPORTS) {
    const ids = idsOf(a);
    console.log(`  ${ids.length ? '○' : '✗'} ${a.padEnd(22)} ${ids.slice(0, 3).map(i => `${S[i].n}[${(S[i].l || []).join(',')}]`).join(' ')}`);
  }
  console.log('\n=== 近年開業/延伸の駅の在否 ===');
  for (const [label, sts] of NEW) {
    console.log(`  ${label}`);
    for (const s of sts) {
      const ids = idsOf(s);
      console.log(`    ${ids.length ? '○' : '✗'} ${s.padEnd(18)} ${ids.slice(0, 2).map(i => `${S[i].n}[${(S[i].l || []).join(',')}]`).join(' ')}`);
    }
  }
}

if (mode === 'all' || mode === 'routes') {
  console.log('\n=== 空港アクセス経路 (平日/土/休) ===');
  const OD = [
    ['東京', '成田空港', 9], ['新宿', '成田空港', 9], ['品川', '羽田空港第2ターミナル', 9],
    ['東京', '羽田空港第1ターミナル', 6], ['横浜', '羽田空港第2ターミナル', 9],
    ['大阪', '関西空港', 9], ['京都', '関西空港', 9], ['三宮', '関西空港', 9],
    ['名古屋', '中部国際空港', 9], ['札幌', '新千歳空港', 9], ['仙台', '仙台空港', 9],
    ['博多', '福岡空港', 9], ['那覇', '那覇空港', 9], ['宮崎', '宮崎空港', 9],
    ['大阪', '大阪空港', 9], ['広島', '広島空港', 9], ['高松', '高松空港', 9],
  ];
  for (const [f, t, hh] of OD) {
    const rs = [0, 1, 2].map(d => best(f, t, hh, d));
    const diff = rs.some(r => r.error) || (rs[0].min !== rs[2].min);
    console.log(`\n■ ${f} → ${t} @${hh}時 ${diff ? '  ← 曜日で差' : ''}`);
    ['平日', '土曜', '休日'].forEach((n, i) => console.log(`  ${n}${show(rs[i])}`));
  }
}
