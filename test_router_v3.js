#!/usr/bin/env node
/* test_router_v3.js — CSAルーターのオフラインテスト
 * Usage: node test_router_v3.js [出発駅 到着駅 [HH:MM]]
 * 引数なしでジョルダン照合込みのテストマトリクス実行
 */
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./router_v3.js');

const BASE = __dirname;
const graph = JSON.parse(fs.readFileSync(path.join(BASE, 'graph_v2.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(BASE, 'trains_v3_meta.json'), 'utf8'));
const fares = JSON.parse(fs.readFileSync(path.join(BASE, 'fares.json'), 'utf8'));
const buf = fs.readFileSync(path.join(BASE, 'trains_v3.bin'));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const t0 = Date.now();
R.loadBinary(ab, meta, graph.stations, fares);
console.error(`[load ${Date.now() - t0}ms, ${R.data.nConn} connections]`);

// index.html の findAllByName と同じ優先順位: 鉄道駅 > バス停、完全一致 > 括弧除去一致。
// 素朴に「最初の完全一致」を返すと、都営バス停の「大曲」「大手町」が鉄道駅(大曲(秋田)/
// 大手町(東京))を隠してしまい、CLIで駅名を打っても意図した駅を引けない。
function idsOf(name) {
  const strip = s => s.replace(/[（(].*?[）)]/g, '');
  const exact = [], loose = [];
  for (let i = 0; i < graph.stations.length; i++) {
    const n = graph.stations[i].n;
    if (n === name) exact.push(i);
    else if (strip(n) === strip(name)) loose.push(i);
  }
  const rail = a => a.filter(i => !graph.stations[i].m);
  for (const cand of [rail(exact), rail(loose), exact, loose]) {
    if (cand.length) return cand;
  }
  return [];
}
const idOf = name => (idsOf(name)[0] ?? -1);

// index.html の doSearch と同じく、同名駅の候補を総当たりして到着の早い順に並べる。
// 「高松」(高松(東京)/高松(石川)/高松(香川))のような同名駅で、先頭候補だけを見ると
// 別地方の駅を掴んで無意味な経路になる。
function journeysByName(fromName, toName, start, opts) {
  const out = [], sigs = new Set();
  for (const s of idsOf(fromName)) {
    for (const g of idsOf(toName)) {
      if (s === g) continue;
      for (const j of R.findJourneys(s, g, start, opts || {})) {
        const sig = `${j.dep}|${j.arr}|` + j.legs.map(l => l.kind === 'ride' ? l.line + l.dep : 'w').join('>');
        if (!sigs.has(sig)) { sigs.add(sig); out.push(j); }
      }
    }
  }
  out.sort((a, b) => (a.arr - b.arr) || (b.dep - a.dep) || (a.transfers - b.transfers));
  return out;
}

const fmt = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function describe(j) {
  const fare = R.journeyFare(j);
  const km = R.journeyKm(j);
  const legsStr = j.legs.map(l => {
    if (l.kind === 'walk') return `徒歩${l.min}分`;
    const nm = i => graph.stations[i].n;
    return `${l.line}${l.type ? '[' + l.type + ']' : ''} ${nm(l.from)}${fmt(l.dep)}→${nm(l.to)}${fmt(l.arr)} (${l.stops.length - 1}駅, ${l.dest}行)`;
  }).join(' / ');
  return {
    summary: `${fmt(j.dep)}→${fmt(j.arr)} ${j.arr - j.dep}分 乗換${j.transfers} ${km.toFixed(1)}km ¥${fare.total}`,
    legsStr, dep: j.dep, arr: j.arr, transfers: j.transfers, fare: fare.total,
  };
}

// --- CLI ---
const args = process.argv.slice(2);
if (args.length >= 2) {
  const t = args[2] ? args[2].split(':') : ['9', '0'];
  const start = (+t[0]) * 60 + (+t[1] || 0);
  if (!idsOf(args[0]).length || !idsOf(args[1]).length) { console.log('駅が見つからない'); process.exit(1); }
  const js = journeysByName(args[0], args[1], start, {});
  if (!js.length) { console.log('経路なし'); process.exit(1); }
  for (const j of js.slice(0, 5)) {
    const d = describe(j);
    console.log(d.summary);
    console.log('   ' + d.legsStr);
  }
  process.exit(0);
}

// --- テストマトリクス (expectDep/expectArr はジョルダン照合) ---
const CASES = [
  // 04:58発総武快速経由05:58着はジョルダン1位(06:04着)より早い実在経路
  { from: '高柳', to: '上野', at: 100, expectDep: [290, 315], expectArr: [350, 365], note: 'ジョルダン1位: 05:13→06:04' },
  // TX 05:32は乗換4分で間に合わない(野田線は柏スイッチバック)→常磐線05:52が正
  { from: '高柳', to: '北千住', at: 100, expectDep: [313, 313], expectArr: [350, 354], note: '実勢: 05:13→05:52' },
  { from: '柏', to: '東京', at: 540, expectMin: [25, 50] },
  { from: '北千住', to: 'つくば', at: 540, expectMin: [30, 70] },
  { from: '新宿', to: '横浜', at: 540, expectMin: [25, 60] },
  { from: '東京', to: '新大阪', at: 540, expectMin: [140, 200] },
  { from: '渋谷', to: '吉祥寺', at: 540, expectMin: [15, 40] },
  { from: '札幌', to: '小樽', at: 540, expectMin: [30, 80] },
  { from: '上野', to: '日暮里', at: 540, expectMin: [2, 15] },
  { from: '鹿児島中央', to: '博多', at: 540, expectMin: [85, 130] },
];

let fail = 0;
for (const c of CASES) {
  const s = idOf(c.from), g = idOf(c.to);
  if (s < 0 || g < 0) { console.log(`✗ ${c.from}→${c.to}: 駅なし`); fail++; continue; }
  const js = R.findJourneys(s, g, c.at, {});
  if (!js.length) { console.log(`✗ ${c.from}→${c.to}: 経路なし`); fail++; continue; }
  const d = describe(js[0]);
  let ok = true, why = [];
  if (c.expectDep && (d.dep < c.expectDep[0] || d.dep > c.expectDep[1])) {
    ok = false; why.push(`発${fmt(d.dep)}≠${fmt(c.expectDep[0])}`);
  }
  if (c.expectArr && (d.arr < c.expectArr[0] || d.arr > c.expectArr[1])) {
    ok = false; why.push(`着${fmt(d.arr)}が範囲外`);
  }
  if (c.expectMin) {
    const tot = d.arr - d.dep;
    if (tot < c.expectMin[0] || tot > c.expectMin[1]) { ok = false; why.push(`${tot}分が範囲外`); }
  }
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${c.from}→${c.to}: ${d.summary}${why.length ? '  [' + why.join(', ') + ']' : ''}${c.note ? '  (' + c.note + ')' : ''}`);
  console.log('   ' + d.legsStr);
}

// --- 予算(運賃上限)フィルタ ---
// opts.maxFare を渡すと候補に j.budget が付き、予算内が1本でもあれば超過分は落ちる。
// 予算内が皆無のときだけ超過候補を budget.over 付きで残す(安い順)。
console.log('\n=== 予算(運賃上限) ===');
const t = (name, ok, extra) => { if (!ok) fail++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`); };
const search = (from, to, at, budget) =>
  R.findJourneys(idOf(from), idOf(to), at, budget == null ? {} : { maxFare: budget });

// 予算未指定なら従来どおり budget は付かない(既存の呼び出しに影響しない)
t('予算未指定では budget が付かない', search('新宿', '横浜', 540).every(j => !j.budget));

for (const c of [
  { from: '新宿', to: '横浜', at: 540, budget: 600 },     // ¥616の埼京線直通が落ち¥508が残る
  { from: '柏',   to: '東京', at: 540, budget: 700 },
  { from: '新宿', to: '松本', at: 540, budget: 4500 },    // あずさ¥6420が落ち各停¥3850が残る
]) {
  const all = search(c.from, c.to, c.at);
  const js  = search(c.from, c.to, c.at, c.budget);
  const fareOf = j => R.journeyFare(j).total;
  const over = js.filter(j => j.budget.over);
  const maxKept = js.length ? Math.max.apply(null, js.map(fareOf)) : 0;
  t(`${c.from}→${c.to} 予算¥${c.budget}: 全件が予算内`,
    js.length > 0 && over.length === 0 && maxKept <= c.budget,
    `${js.length}件 最高¥${maxKept} (予算なしなら${all.length}件 最高¥${Math.max.apply(null, all.map(fareOf))})`);
  // 予算なしだと超過候補が混ざる区間であること(=このケースがテストとして有意)。
  // 件数は「安い候補の補充」で埋まることがあるので、件数の減少では判定しない。
  t(`${c.from}→${c.to} 予算なしでは超過候補が混ざる(フィルタが効いている)`,
    all.some(j => fareOf(j) > c.budget),
    `${all.length}件中 超過${all.filter(j => fareOf(j) > c.budget).length}件 → 予算あり${js.length}件`);
}

// 予算内が存在しないケース: 落とさず超過フラグ付きで残し、最安を先頭にする
{
  const js = search('東京', '新大阪', 540, 3000);
  const mins = js.map(j => j.budget.minFare).filter(v => v != null);
  t('予算内が皆無なら候補を落とさず残す', js.length > 0, `${js.length}件`);
  t('残った候補は全て budget.over', js.every(j => j.budget.over));
  t('最安が先頭に来る', js[0].budget.minFare === Math.min.apply(null, mins),
    `先頭¥${js[0].budget.minFare} 最安¥${Math.min.apply(null, mins)}`);
  t('overBy が不足額になっている', js[0].budget.overBy === js[0].budget.minFare - 3000);
}

// 席種で予算内/超過が変わる経路は落とさず seatHint を付ける(自由席なら収まる)
{
  const jn = search('東京', '新大阪', 540, 14000).find(j => j.budget.seatHint);
  t('指定席では超過・自由席なら予算内の経路に seatHint が付く', !!jn,
    jn ? `指定¥${jn.budget.fare} 自由¥${jn.budget.minFare} hint=${jn.budget.seatHint}` : '');
  t('seatHint 付きの経路は予算内として残る', !!jn && jn.budget.over === false);
}

// 運賃を算出できない経路(バス絡み)は判定不能として残す
{
  const bid = graph.stations.findIndex(s => s.m && s.n === '晴海三丁目');
  const js = R.findJourneys(idOf('新橋'), bid, 600, { day: 0, maxFare: 200 });
  t('バス絡みは予算判定不能(unknown)として残る',
    js.length > 0 && js.every(j => j.budget.unknown && !j.budget.over), `${js.length}件`);
}

// 次の便/前の便も予算超過を読み飛ばす
{
  const s = idOf('東京'), g = idOf('新大阪'), opts = { maxFare: 14000 };
  const j0 = search('東京', '新大阪', 540, 14000)[0];
  const nx = R.nextJourney(s, g, j0.dep, opts);
  const pv = R.prevJourney(s, g, j0.dep, opts);
  t('nextJourney が予算情報を付けて返す', !!nx && !!nx.budget && nx.dep > j0.dep);
  t('prevJourney が予算情報を付けて返す', !!pv && !!pv.budget && pv.dep < j0.dep);
  t('予算未指定の nextJourney は従来どおり budget を付けない',
    !(R.nextJourney(s, g, 540, {}) || {}).budget);
}

console.log(fail === 0 ? '\nALL OK' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
