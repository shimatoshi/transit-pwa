#!/usr/bin/env node
/* qa_direction.js — 駅間の上下方向カバレッジ検査。
 *
 * 2つの見方で数える:
 *   (1) 有向区間ベース: 時刻表に現れる連続停車パターン a→b のうち逆 b→a が0本のもの。
 *       特急の千鳥停車(下りだけ通過する駅がある等)も拾うので、数え上げの上限。
 *   (2) 物理隣接ベース: graph_v2.edges(駅リスト由来の隣接)を上下それぞれで見る。
 *       停車パターンの非対称は消え、「線路は在るのに片方向の列車が1本も無い」だけが残る。
 *       ビルド時の検査にはこちらを使う。
 *
 * Usage:
 *   node qa_direction.js            レポート
 *   node qa_direction.js --check    (2)が oneway_allow.json を超えたら exit 1
 *   node qa_direction.js --dump     (2)の残りを oneway_allow.json 形式で標準出力へ
 */
'use strict';
const fs = require('fs');
const C = require('./qa_coverage.js');
const { g, m, ntrips, tripOff, rawS } = C;
const nm = i => g.stations[i].n;

const MODE = process.argv[2] || '';

// ---- 有向区間 -> 便数, および路線 ----
const cnt = new Map(); // "a>b" -> n
const edgeLine = new Map();
for (let t = 0; t < ntrips; t++) {
  if (m.trips.m && m.trips.m[t] === 1) continue; // バス系統は除外
  const L = m.lines[m.trips.l[t]];
  for (let i = tripOff[t]; i < tripOff[t + 1] - 1; i++) {
    const a = rawS[i], b = rawS[i + 1];
    const k = `${a}>${b}`;
    cnt.set(k, (cnt.get(k) || 0) + 1);
    if (!edgeLine.has(k)) edgeLine.set(k, new Set());
    edgeLine.get(k).add(L);
  }
}
const oneway = [];
for (const [k, n] of cnt) {
  const [a, b] = k.split('>').map(Number);
  if (!cnt.has(`${b}>${a}`)) oneway.push({ a, b, n, lines: [...edgeLine.get(k)] });
}

// ---- 物理隣接エッジ(graph_v2.edges)の方向別カバレッジ ----
const seen = new Set();
const gaps = [];   // 線路は在るが片方向(または両方向)の列車が無い
let nEdges = 0;
for (const [k, arr] of Object.entries(g.edges)) {
  const a = +k;
  for (const [b, , line] of arr) {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nEdges++;
    const f = cnt.has(`${a}>${b}`), r = cnt.has(`${b}>${a}`);
    if (f && r) continue;
    // 向きを「列車が在る方 → 無い方」に正規化して出す
    const [from, to] = f ? [a, b] : [b, a];
    gaps.push({ line, from: nm(from), to: nm(to), both: !f && !r });
  }
}

// ---- 既知の許容リスト ----
const ALLOW_FILE = __dirname + '/oneway_allow.json';
const allow = fs.existsSync(ALLOW_FILE) ? JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')) : { allow: [] };
const allowKey = new Set(allow.allow.map(e => `${e.line}\t${e.from}\t${e.to}`));
const unexpected = gaps.filter(x => !allowKey.has(`${x.line}\t${x.from}\t${x.to}`));

if (MODE === '--dump') {
  const out = gaps.map(({ line, from, to }) => ({ line, from, to }))
    .sort((x, y) => x.line.localeCompare(y.line) || x.from.localeCompare(y.from));
  console.log(JSON.stringify({
    note: '線路はあるが片方向の列車しか無い区間の許容リスト。qa_direction.js --check は ' +
          'これを超えた分を落とす。ここに載っているのは環状運転(ユーカリが丘線)や、' +
          '特急が通過駅を飛ばしてできた見かけの隣接(飯田線 平岡–伊那小沢。実際は間に鶯巣)で、' +
          'いずれも node qa_direction_probe.js でその向きに鉄道で行けることを確認済み。' +
          '更新するときは --dump し直したうえで probe も通すこと。',
    allow: out,
  }, null, 1));
  process.exit(0);
}

const byLine = arr => {
  const mp = new Map();
  for (const o of arr) {
    const k = o.lines ? o.lines.join('/') : o.line;
    if (!mp.has(k)) mp.set(k, []);
    mp.get(k).push(o);
  }
  return [...mp.entries()].sort((a, b) => b[1].length - a[1].length);
};

if (MODE !== '--check') {
  console.log(`=== (1) 逆方向の列車が1本も無い有向区間: ${oneway.length} / 全${cnt.size}有向区間 ===`);
  console.log('(環状運転・単線ループ・特急の千鳥停車なら正常。往復する路線なら★データ欠落)');
  byLine(oneway).forEach(([L, arr]) => {
    console.log(`\n  【${L}】 ${arr.length}区間`);
    arr.slice(0, 40).forEach(o => console.log(`     ${nm(o.a)}→${nm(o.b)} ${o.n}本 (逆方向0本)`));
    if (arr.length > 40) console.log(`     … 他${arr.length - 40}区間`);
  });
  console.log('');
}

console.log(`=== (2) 線路はあるが片方向の列車しか無い区間: ${gaps.length} / 全${nEdges}隣接エッジ ===`);
console.log(`    (許容リスト ${allowKey.size}件, 許容外 ${unexpected.length}件)`);
byLine(unexpected).forEach(([L, arr]) => {
  console.log(`  ${L} (${arr.length}): ` +
    arr.map(o => `${o.from}→${o.to}${o.both ? '[両方向0本]' : ''}`).join(' '));
});

if (MODE === '--check') {
  if (unexpected.length) {
    console.error(`\nNG: 許容リストに無い片方向欠落が ${unexpected.length}区間あります。` +
      '\n    python3 gapfill_reverse.py でデータを取り直すか、' +
      '正常(環状運転・特急の見かけ隣接)なら許容リストを更新してください:' +
      '\n      node qa_direction.js --dump > /tmp/a.json && mv /tmp/a.json oneway_allow.json' +
      '\n      node qa_direction_probe.js   # 更新後、実際に逆向きへ行けることを確認');
    process.exit(1);
  }
  console.log('\nOK: 片方向欠落は許容リストの範囲内です。');
}
