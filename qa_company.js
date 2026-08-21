#!/usr/bin/env node
/* qa_company.js — 駅の会社判定(stationCompanies)がどれだけ解決できているかを見る。
 *
 * journeyFare は legParts() で「両端駅の会社集合の共通部分」から区間の運賃会社を
 * 決める。会社集合は駅の wl(wikidata由来の乗り入れ路線名)を lineCompany() に
 * 通して作るが、wl は「関西空港線」「阪和線」「大阪環状線」のように事業者接頭辞の
 * 無い路線名で入っている。fares.json の match/prefix はＪＲ接頭辞付きしか持たない
 * ものがあるため、JR線が会社不明になり、駅が「JRでない」ことにされる。
 *
 * 実害: はるか(京都→関西空港)の運賃が
 *   JR西日本電特¥840 + 南海¥690 + 南海空港加算¥190 + はるか料金¥1730 = ¥3450
 * と、JR完結の行程なのに南海運賃+南海の空港加算運賃で構成される(実際は
 * 乗車券¥1910 + 特急料金¥1730 = ¥3640)。
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

// wl に出てくる路線名を集計し、会社が引けないものを数える
const cnt = new Map();
for (const s of S) for (const L of (s.wl || [])) cnt.set(L, (cnt.get(L) || 0) + 1);
const unresolved = [...cnt].filter(([L]) => !R.lineCompany(L));
unresolved.sort((a, b) => b[1] - a[1]);
console.log(`wl に出る路線名: ${cnt.size}種  会社が引けない: ${unresolved.length}種`);
console.log(`(のべ ${unresolved.reduce((a, x) => a + x[1], 0)} / ${[...cnt.values()].reduce((a, b) => a + b, 0)} 件)`);
console.log('\n=== 会社が引けない路線名 上位40 ===');
unresolved.slice(0, 40).forEach(([L, n]) => console.log(`  ${String(n).padStart(4)}駅  ${L}`));

// 「JR線しか無いのに会社集合が空 or JRを含まない」駅
console.log('\n=== 路線タグ(l)はJRなのに、wl から JR が引けない鉄道駅 ===');
const bad = [];
for (let i = 0; i < S.length; i++) {
  const s = S[i];
  if (s.m) continue;
  const ls = s.l || [];
  if (!ls.length || !ls.some(L => /^(ＪＲ|JR)/.test(L))) continue;
  const cos = new Set((s.wl || []).map(L => R.lineCompany(L)).filter(Boolean));
  if (![...cos].some(c => c === 'JR' || c.startsWith('JR'))) bad.push([i, [...cos]]);
}
console.log(`  該当 ${bad.length}駅 / JR駅`);
bad.slice(0, 30).forEach(([i, cos]) => console.log(`  ${S[i].n}  wl=${JSON.stringify(S[i].wl)} → 会社=${JSON.stringify(cos)}`));
