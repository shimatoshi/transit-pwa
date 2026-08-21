#!/usr/bin/env node
/* qa_company.js — 駅の会社判定(stationCompanies)のカバレッジQA (Issue #15)
 *
 *   node qa_company.js
 *
 * 見るもの:
 *   1) wl(Wikidata路線名)のうち会社が引けない名前の種類/のべ件数
 *   2) 路線タグ(l)にＪＲがあるのに wl から JR が引けない鉄道駅(運賃が私鉄に化ける候補)
 *   3) 路線タグにＪＲが無いのに JR が付く駅(逆方向の誤爆。三セク・地下鉄の巻き込み検出)
 *
 * 2)3)の突き合わせに使う路線タグ l は直通列車ラベルで汚染されているため厳密な正解では
 * 無いが、傾向の監視には十分(修正前: 2)=247駅/誤爆711駅 → 実体リスト照合後: 下記出力)。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const R = require('./router_v3.js');
const graph = JSON.parse(fs.readFileSync(path.join(__dirname, 'graph_v2.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'trains_v3_meta.json'), 'utf8'));
const fares = JSON.parse(fs.readFileSync(path.join(__dirname, 'fares.json'), 'utf8'));
const buf = fs.readFileSync(path.join(__dirname, 'trains_v3.bin'));
R.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  meta, graph.stations, fares);

const S = graph.stations;
const isJRName = s => /^(ＪＲ|JR)/.test(s);

// ---- 1) wl路線名の解決率 ----
// stationCompanies が空を返した駅の wl 名を「引けない」とみなす(実挙動ベース)
const lineUse = new Map();      // wl名 → のべ駅数
const lineUnresolved = new Map();
let stTotal = 0;
for (let i = 0; i < S.length; i++) {
  const s = S[i];
  if (s.m || !s.wl || !s.wl.length) continue;
  stTotal++;
  const cs = R.stationCompanies(i);
  for (const w of s.wl) {
    lineUse.set(w, (lineUse.get(w) || 0) + 1);
    // その駅の会社集合に何も寄与しなかった名前(単独で判定して空)を数える
    if (!R.lineCompany(w) && !cs.size) lineUnresolved.set(w, (lineUnresolved.get(w) || 0) + 1);
  }
}
const totalUse = [...lineUse.values()].reduce((a, b) => a + b, 0);
console.log(`wl に出る路線名: ${lineUse.size}種  wlを持つ鉄道駅: ${stTotal}駅 (のべ${totalUse}件)`);

// ---- 2) 路線タグはJRなのに wl から JR が引けない鉄道駅 ----
const missNames = new Map();
const missSamples = [];
let jrTagged = 0, jrMiss = 0;
for (let i = 0; i < S.length; i++) {
  const s = S[i];
  if (s.m) continue;
  if (!(s.l || []).some(isJRName)) continue;
  jrTagged++;
  const cs = R.stationCompanies(i);
  if (cs.has('JR')) continue;
  jrMiss++;
  if (missSamples.length < 10) {
    missSamples.push(`  ${s.n}   wl=${JSON.stringify(s.wl || [])} → 会社=[${[...cs]}]`);
  }
  for (const w of (s.wl || [])) {
    if (!R.lineCompany(w)) missNames.set(w, (missNames.get(w) || 0) + 1);
  }
}
console.log(`\n=== 路線タグ(l)はJRなのに、wl から JR が引けない鉄道駅 ===`);
console.log(`  該当 ${jrMiss}駅 / JRタグ駅${jrTagged}件`);
missSamples.forEach(x => console.log(x));
const top = [...missNames].sort((a, b) => b[1] - a[1]).slice(0, 15);
if (top.length) {
  console.log('  未解決の路線名(上位):');
  for (const [k, v] of top) console.log(`    ${v}駅  ${k}`);
}

// ---- 3) 路線タグにJRが無いのに JR が付く駅(誤爆の監視) ----
let falseJR = 0;
const falseSamples = [];
for (let i = 0; i < S.length; i++) {
  const s = S[i];
  if (s.m) continue;
  if ((s.l || []).some(isJRName)) continue;
  if (R.stationCompanies(i).has('JR')) {
    falseJR++;
    if (falseSamples.length < 10) falseSamples.push(`  ${s.n}   wl=${JSON.stringify(s.wl || [])}`);
  }
}
console.log(`\n=== 路線タグにJRが無いのに JR が付く鉄道駅(誤爆候補) ===`);
console.log(`  該当 ${falseJR}駅`);
falseSamples.forEach(x => console.log(x));
console.log('\n(路線タグ l は直通ラベルで汚染されているため、少数の残存は許容)');
