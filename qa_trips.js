#!/usr/bin/env node
/* qa_trips.js — 指定路線の全tripの停車パターンを表示
 * Usage: node qa_trips.js <路線名> [最大本数]
 */
'use strict';
const C = require('./qa_coverage.js');
const { g, m, ntrips, tripOff, rawS, rawA, rawD } = C;
const nm = i => g.stations[i].n;
const fmt = t => t === 65535 || t < 0 ? '--:--' : `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const L = process.argv[2];
const MAX = +(process.argv[3] || 12);
let shown = 0, count = 0;
for (let t = 0; t < ntrips; t++) {
  if (m.lines[m.trips.l[t]] !== L) continue;
  count++;
  if (shown >= MAX) continue;
  shown++;
  const stops = [];
  for (let i = tripOff[t]; i < tripOff[t + 1]; i++) {
    const d = rawD[i] === 65535 ? rawA[i] : rawD[i];
    stops.push(`${nm(rawS[i])}${fmt(d)}`);
  }
  console.log(`#${t} [${m.types[m.trips.t[t]]}] →${m.trips.d[t]} cal=${m.trips.c[t]} mode=${m.trips.m[t]}`);
  console.log('   ' + stops.join(' '));
}
console.log(`--- ${L}: ${count} trips (表示 ${shown}) ---`);
