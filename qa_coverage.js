#!/usr/bin/env node
/* qa_coverage.js — 路線ごとの時刻表カバレッジ分析 (QA用)
 * Usage: node qa_coverage.js [summary|orphans|firstlast|line <路線名>]
 */
'use strict';
const fs = require('fs');
const g = JSON.parse(fs.readFileSync(__dirname + '/graph_v2.json', 'utf8'));
const m = JSON.parse(fs.readFileSync(__dirname + '/trains_v3_meta.json', 'utf8'));
const buf = fs.readFileSync(__dirname + '/trains_v3.bin');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dv = new DataView(ab);
const ntrips = dv.getUint32(4, true), nstops = dv.getUint32(8, true);
let off = 12; const a4 = x => (x + 3) & ~3;
const tripOff = new Uint32Array(ab, off, ntrips + 1); off = a4(off + (ntrips + 1) * 4);
const rawS = new Uint16Array(ab, off, nstops); off = a4(off + nstops * 2);
const rawA = new Uint16Array(ab, off, nstops); off = a4(off + nstops * 2);
const rawD = new Uint16Array(ab, off, nstops); off = a4(off + nstops * 2);

// 路線 -> 駅集合 (graph_v2 の stations[].l)
const lineStations = new Map();
g.stations.forEach((s, i) => (s.l || []).forEach(L => {
  if (!lineStations.has(L)) lineStations.set(L, new Set());
  lineStations.get(L).add(i);
}));
// 路線 -> trip数, 駅集合(時刻表側)
const lineTrips = new Map(), lineTTStations = new Map(), lineMode = new Map();
const stHasTrip = new Uint8Array(g.stations.length);
const stDepTimes = new Map();
for (let t = 0; t < ntrips; t++) {
  const L = m.lines[m.trips.l[t]];
  lineTrips.set(L, (lineTrips.get(L) || 0) + 1);
  lineMode.set(L, m.trips.m ? m.trips.m[t] : 0);
  if (!lineTTStations.has(L)) lineTTStations.set(L, new Set());
  const set = lineTTStations.get(L);
  for (let i = tripOff[t]; i < tripOff[t + 1]; i++) {
    const s = rawS[i]; set.add(s); stHasTrip[s] = 1;
    const d = rawD[i] === 65535 ? (rawA[i] === 65535 ? -1 : rawA[i]) : rawD[i];
    if (d >= 0) { if (!stDepTimes.has(s)) stDepTimes.set(s, []); stDepTimes.get(s).push(d); }
  }
}
module.exports = { g, m, ntrips, nstops, tripOff, rawS, rawA, rawD, lineStations, lineTrips, lineTTStations, lineMode, stHasTrip, stDepTimes };

const nm = i => g.stations[i].n;
const fmt = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

if (require.main === module) {
  const mode = process.argv[2] || 'summary';
  if (mode === 'summary') {
    console.log('=== 路線数 ===');
    console.log('graph_v2 路線(駅リスト側):', lineStations.size);
    console.log('meta 路線(時刻表側):', m.lines.length, '/ 実際にtripを持つ:', lineTrips.size);
    const gl = new Set(lineStations.keys()), tl = new Set(lineTrips.keys());
    const noTT = [...gl].filter(L => !tl.has(L)).sort();
    const noGraph = [...tl].filter(L => !gl.has(L)).sort();
    console.log(`\n=== (A) 駅リストにあるが時刻表trip 0本の路線: ${noTT.length} ===`);
    noTT.forEach(L => console.log(`  ${L}  (${lineStations.get(L).size}駅)  例: ${[...lineStations.get(L)].slice(0, 4).map(nm).join('/')}`));
    console.log(`\n=== (B) 時刻表にあるが graph_v2 の駅リストに無い路線: ${noGraph.length} ===`);
    noGraph.forEach(L => console.log(`  ${L}  trips=${lineTrips.get(L)} mode=${lineMode.get(L)}`));
  } else if (mode === 'orphans') {
    // 駅リストに載っているのに時刻表に一度も登場しない駅
    const orph = [];
    for (let i = 0; i < g.stations.length; i++) {
      if (!stHasTrip[i]) orph.push(i);
    }
    console.log(`=== 時刻表に1本も現れない駅: ${orph.length} / ${g.stations.length} ===`);
    const byLine = new Map();
    orph.forEach(i => {
      const ls = g.stations[i].l && g.stations[i].l.length ? g.stations[i].l : ['(路線なし)'];
      ls.forEach(L => { if (!byLine.has(L)) byLine.set(L, []); byLine.get(L).push(i); });
    });
    [...byLine.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([L, arr]) => {
      const tot = lineStations.has(L) ? lineStations.get(L).size : arr.length;
      console.log(`  ${L}: ${arr.length}/${tot}駅  ${arr.slice(0, 12).map(nm).join(' ')}${arr.length > 12 ? ' …' : ''}`);
    });
  } else if (mode === 'firstlast') {
    // 路線ごとの始発・終電(全駅の発時刻の min/max)と本数
    const rows = [];
    for (const [L, set] of lineTTStations) {
      let mn = 1e9, mx = -1;
      for (const s of set) {
        const ds = stDepTimes.get(s); if (!ds) continue;
        for (const d of ds) { if (d < mn) mn = d; if (d > mx) mx = d; }
      }
      rows.push({ L, trips: lineTrips.get(L), stations: set.size, mn, mx, mode: lineMode.get(L) });
    }
    rows.sort((a, b) => a.trips - b.trips);
    console.log('trips\t駅\t始発\t終発\t路線');
    rows.forEach(r => console.log(`${r.trips}\t${r.stations}\t${fmt(r.mn)}\t${fmt(r.mx)}\t${r.L}${r.mode ? ' [バス]' : ''}`));
  } else if (mode === 'line') {
    const L = process.argv[3];
    const gs = lineStations.get(L), ts = lineTTStations.get(L);
    console.log(`路線: ${L}`);
    console.log(`  駅リスト側: ${gs ? gs.size : 0}駅`);
    console.log(`  時刻表側 : ${ts ? ts.size : 0}駅, trips=${lineTrips.get(L) || 0}`);
    if (gs && ts) {
      const missing = [...gs].filter(i => !ts.has(i));
      const extra = [...ts].filter(i => !gs.has(i));
      console.log(`  時刻表に無い駅(${missing.length}): ${missing.map(nm).join(' ')}`);
      console.log(`  駅リストに無い駅(${extra.length}): ${extra.map(nm).join(' ')}`);
    }
    if (ts) {
      const sorted = [...ts].sort((a, b) => (stDepTimes.get(a) ? Math.min(...stDepTimes.get(a)) : 1e9) - (stDepTimes.get(b) ? Math.min(...stDepTimes.get(b)) : 1e9));
      sorted.forEach(s => {
        const ds = stDepTimes.get(s) || [];
        console.log(`    ${nm(s)}: ${ds.length}本 ${ds.length ? fmt(Math.min(...ds)) + '〜' + fmt(Math.max(...ds)) : '-'}`);
      });
    }
  }
}
