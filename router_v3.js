/* router_v3.js — 実在列車ベースの経路検索 (Connection Scan Algorithm).
 *
 * v2までの「グラフ最短路＋時刻を後付け」近似と違い、trains.json由来の
 * 全列車(trips)の停車時刻をそのまま辿るので、出る時刻・着く時刻が
 * 時刻表どおりになる。
 *
 * データ: trains_v3.bin (make_trains_v3.py 参照) + trains_v3_meta.json
 *         + graph_v2.json の stations (駅名・座標・駅名検索用)
 *
 * Works in browser (window.RouterV3) and node (module.exports).
 */
(function (global) {
'use strict';

const MIN_TRANSFER = 4;   // 同一駅乗換の標準バッファ(分)
const RAIL_KM_FACTOR = 1.12;
const INF = 0x3fffffff;

// 有料優等判定 (router.js と同一ロジック)
const FREE_TYPE_RE = /^(普通|各駅停車|各停|ワンマン|ＢＲＴ|BRT|バス|快速|新快速|区間快速|特別快速|通勤快速|快速急行|通勤急行|急行|区間急行|準急|区間準急|特快|通勤特快|中央特快|青梅特快|快特|エアポート|アクセス特急|直通特急|通勤特急|快速特急|特急)/;

const D = {
  stations: null,   // graph_v2 stations
  lines: null, types: null,
  tripLine: null, tripType: null, tripDest: null,
  tripOff: null, stS: null, stA: null, stD: null, // 正規化済み(単調増加)
  // connections (depT昇順)
  cDepS: null, cDepT: null, cArrS: null, cArrT: null, cTrip: null, cStopI: null,
  nConn: 0,
  foot: null,       // station -> [[to, walkMin], ...]
  fares: null,
  tripPaid: null, tripShink: null, // Uint8 per trip
};

function loadBinary(arrayBuffer, meta, stations, fares) {
  D.stations = stations;
  D.fares = fares || null;
  D.lines = meta.lines;
  D.types = meta.types;
  D.tripLine = meta.trips.l;
  D.tripType = meta.trips.t;
  D.tripDest = meta.trips.d;

  const dv = new DataView(arrayBuffer);
  if (dv.getUint8(0) !== 0x54 || dv.getUint8(1) !== 0x56 || dv.getUint8(2) !== 0x33) {
    throw new Error('bad trains_v3.bin magic');
  }
  const ntrips = dv.getUint32(4, true);
  const nstops = dv.getUint32(8, true);
  let off = 12;
  const align4 = x => (x + 3) & ~3;
  D.tripOff = new Uint32Array(arrayBuffer, off, ntrips + 1);
  off = align4(off + (ntrips + 1) * 4);
  const rawS = new Uint16Array(arrayBuffer, off, nstops); off = align4(off + nstops * 2);
  const rawA = new Uint16Array(arrayBuffer, off, nstops); off = align4(off + nstops * 2);
  const rawD = new Uint16Array(arrayBuffer, off, nstops); off = align4(off + nstops * 2);

  // 時刻正規化: trip内で時刻が戻ったら日跨ぎ(+1440)。65535=なし
  D.stS = rawS;
  const A = new Int32Array(nstops), Dp = new Int32Array(nstops);
  for (let t = 0; t < ntrips; t++) {
    let base = 0, prev = -1;
    for (let i = D.tripOff[t]; i < D.tripOff[t + 1]; i++) {
      let a = rawA[i] === 65535 ? -1 : rawA[i] + base;
      if (a >= 0 && prev >= 0 && a < prev) { base += 1440; a += 1440; }
      if (a >= 0) prev = a;
      let d = rawD[i] === 65535 ? -1 : rawD[i] + base;
      if (d >= 0 && prev >= 0 && d < prev) { base += 1440; d += 1440; }
      if (d >= 0) prev = d;
      A[i] = a; Dp[i] = d;
    }
  }
  D.stA = A; D.stD = Dp;

  // trip属性 (有料特急/新幹線)
  const paid = new Uint8Array(ntrips), shink = new Uint8Array(ntrips);
  for (let t = 0; t < ntrips; t++) {
    const line = D.lines[D.tripLine[t]] || '';
    const type = D.types[D.tripType[t]] || '';
    if (line.includes('新幹線')) shink[t] = 1;
    else if (type && !FREE_TYPE_RE.test(type)) paid[t] = 1;
  }
  D.tripPaid = paid; D.tripShink = shink;

  // connections 構築: trip内の連続停車ペア
  let n = 0;
  for (let t = 0; t < ntrips; t++) {
    for (let i = D.tripOff[t]; i < D.tripOff[t + 1] - 1; i++) {
      if (Dp[i] >= 0 && (A[i + 1] >= 0 || Dp[i + 1] >= 0)) n++;
    }
  }
  // 深夜跨ぎ検索用に dep<360 のconnを+1440で複製
  let extra = 0;
  for (let t = 0; t < ntrips; t++) {
    for (let i = D.tripOff[t]; i < D.tripOff[t + 1] - 1; i++) {
      if (Dp[i] >= 0 && Dp[i] < 360 && (A[i + 1] >= 0 || Dp[i + 1] >= 0)) extra++;
    }
  }
  const total = n + extra;
  const cDepS = new Uint16Array(total), cArrS = new Uint16Array(total);
  const cDepT = new Int32Array(total), cArrT = new Int32Array(total);
  const cTrip = new Int32Array(total), cStopI = new Int32Array(total);
  let k = 0;
  function emit(t, i, shift) {
    const arr = A[i + 1] >= 0 ? A[i + 1] : Dp[i + 1];
    cDepS[k] = D.stS[i]; cArrS[k] = D.stS[i + 1];
    cDepT[k] = Dp[i] + shift; cArrT[k] = arr + shift;
    cTrip[k] = t; cStopI[k] = i; k++;
  }
  for (let t = 0; t < ntrips; t++) {
    for (let i = D.tripOff[t]; i < D.tripOff[t + 1] - 1; i++) {
      if (Dp[i] >= 0 && (A[i + 1] >= 0 || Dp[i + 1] >= 0)) {
        emit(t, i, 0);
        if (Dp[i] < 360) emit(t, i, 1440);
      }
    }
  }
  // depT昇順ソート (index sort)
  const idx = Array.from({ length: total }, (_, x) => x);
  idx.sort((a, b) => cDepT[a] - cDepT[b]);
  D.cDepS = new Uint16Array(total); D.cArrS = new Uint16Array(total);
  D.cDepT = new Int32Array(total); D.cArrT = new Int32Array(total);
  D.cTrip = new Int32Array(total); D.cStopI = new Int32Array(total);
  for (let x = 0; x < total; x++) {
    const s = idx[x];
    D.cDepS[x] = cDepS[s]; D.cArrS[x] = cArrS[s];
    D.cDepT[x] = cDepT[s]; D.cArrT[x] = cArrT[s];
    D.cTrip[x] = cTrip[s]; D.cStopI[x] = cStopI[s];
  }
  D.nConn = total;

  // footpaths
  D.foot = {};
  for (const [a, b, w] of meta.footpaths) {
    (D.foot[a] = D.foot[a] || []).push([b, w]);
    (D.foot[b] = D.foot[b] || []).push([a, w]);
  }
}

function firstConnAfter(t) {
  let lo = 0, hi = D.nConn;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (D.cDepT[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// CSA earliest-arrival。返値: journey or null
function query(srcIdx, dstIdx, depMin, opts) {
  opts = opts || {};
  const useExpress = opts.express !== false;
  const useShink = opts.shinkansen !== false;
  const banTrips = opts.banTrips || null; // Set of trip ids

  const ns = D.stations.length;
  const arr = new Int32Array(ns).fill(INF);
  const inConn = new Int32Array(ns).fill(-1);   // 到着connインデックス
  const inBoard = new Int32Array(ns).fill(-1);  // そのtripに乗ったconn
  const inFoot = new Int32Array(ns).fill(-1);   // 徒歩で来た場合の元駅
  const tripBoard = new Int32Array(D.tripLine.length).fill(-1);

  arr[srcIdx] = depMin;
  if (D.foot[srcIdx]) {
    for (const [to, w] of D.foot[srcIdx]) {
      if (depMin + w < arr[to]) { arr[to] = depMin + w; inFoot[to] = srcIdx; }
    }
  }

  for (let c = firstConnAfter(depMin); c < D.nConn; c++) {
    const dT = D.cDepT[c];
    if (dT > arr[dstIdx]) break; // これ以降は改善不可
    const trip = D.cTrip[c];
    if (banTrips && banTrips.has(trip)) continue;
    if (!useShink && D.tripShink[trip]) continue;
    if (!useExpress && D.tripPaid[trip]) continue;

    const dS = D.cDepS[c];
    let board = tripBoard[trip] !== -1;
    if (!board && arr[dS] < INF) {
      // 同一駅乗換バッファ。出発駅(=直接歩いて来た/検索起点)はバッファ0
      const buf = (dS === srcIdx || inFoot[dS] >= 0) && inConn[dS] === -1 ? 0 : MIN_TRANSFER;
      if (arr[dS] + buf <= dT) board = true;
    }
    if (!board) continue;
    if (tripBoard[trip] === -1) tripBoard[trip] = c;

    const aS = D.cArrS[c], aT = D.cArrT[c];
    if (aT < arr[aS]) {
      arr[aS] = aT;
      inConn[aS] = c;
      inBoard[aS] = tripBoard[trip];
      inFoot[aS] = -1;
      if (D.foot[aS]) {
        for (const [to, w] of D.foot[aS]) {
          if (aT + w < arr[to]) {
            arr[to] = aT + w;
            inConn[to] = c;          // 徒歩元の到着conn
            inBoard[to] = tripBoard[trip];
            inFoot[to] = aS;
          }
        }
      }
    }
  }

  if (arr[dstIdx] >= INF) return null;

  // 経路復元
  const legs = [];
  let cur = dstIdx;
  while (cur !== srcIdx) {
    if (inFoot[cur] >= 0 && inConn[cur] === -1) {
      // 起点からの徒歩
      legs.unshift({ kind: 'walk', from: inFoot[cur], to: cur, min: arr[cur] - depMin });
      cur = inFoot[cur];
      continue;
    }
    const viaFoot = inFoot[cur] >= 0;
    const rideEnd = viaFoot ? inFoot[cur] : cur;
    const cEnd = inConn[cur], cStart = inBoard[cur];
    if (cEnd === -1 || cStart === -1) return null; // 整合性エラー
    if (viaFoot) {
      legs.unshift({ kind: 'walk', from: rideEnd, to: cur, min: arr[cur] - D.cArrT[cEnd] });
    }
    const trip = D.cTrip[cEnd];
    // trip内の停車列を stopI で抽出
    const i0 = D.cStopI[cStart], i1 = D.cStopI[cEnd] + 1;
    const shift = D.cDepT[cStart] - D.stD[i0]; // +1440複製conn対応
    const stops = [];
    for (let i = i0; i <= i1; i++) {
      stops.push({
        st: D.stS[i],
        a: D.stA[i] >= 0 ? D.stA[i] + shift : null,
        d: D.stD[i] >= 0 ? D.stD[i] + shift : null,
      });
    }
    legs.unshift({
      kind: 'ride', trip,
      line: D.lines[D.tripLine[trip]],
      type: D.types[D.tripType[trip]],
      dest: D.tripDest[trip],
      stops,
      dep: D.cDepT[cStart], arr: D.cArrT[cEnd],
      from: D.cDepS[cStart], to: rideEnd,
    });
    cur = D.cDepS[cStart];
  }

  // ループ簡約: あるrideが起点を再通過するなら、そこから乗る形に直す
  // (同着タイで「一駅戻って同じ列車に乗る」経路が出るのを防ぐ)
  let trimLeg = -1, trimStop = -1;
  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li];
    if (leg.kind !== 'ride') continue;
    for (let si = 0; si < leg.stops.length - 1; si++) {
      if (leg.stops[si].st === srcIdx && leg.stops[si].d != null && (li > 0 || si > 0)) {
        trimLeg = li; trimStop = si;
      }
    }
  }
  if (trimLeg >= 0) {
    const leg = legs[trimLeg];
    leg.stops = leg.stops.slice(trimStop);
    leg.from = srcIdx;
    leg.dep = leg.stops[0].d;
    legs.splice(0, trimLeg);
  }

  const rides = legs.filter(l => l.kind === 'ride');
  if (!rides.length) return null;
  return {
    legs,
    dep: legs[0].kind === 'walk' ? journeyWalkAdjustedDep(legs) : rides[0].dep,
    arr: arr[dstIdx],
    transfers: rides.length - 1,
  };
}

function journeyWalkAdjustedDep(legs) {
  // 先頭が徒歩の場合: 最初の乗車に間に合う出発時刻
  const ride = legs.find(l => l.kind === 'ride');
  let walk = 0;
  for (const l of legs) {
    if (l.kind === 'ride') break;
    walk += l.min;
  }
  return ride.dep - walk;
}

// --- 距離・運賃 (router.jsの方式を踏襲: 停車列に沿ったhaversine×1.12) ---
function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371, rad = Math.PI / 180;
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
  const a = Math.sin(dLa / 2) ** 2 +
    Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function legKm(leg) {
  let km = 0;
  for (let i = 1; i < leg.stops.length; i++) {
    const a = D.stations[leg.stops[i - 1].st], b = D.stations[leg.stops[i].st];
    if (a.la != null && b.la != null) {
      km += haversineKm(a.la, a.lo, b.la, b.lo) * RAIL_KM_FACTOR;
    }
  }
  return km;
}

function canonLine(s) {
  if (!s) return '';
  return s
    .replace(/ＪＲ|JR/g, '')
    .replace(/東京メトロ/g, '')
    .replace(/都営地下鉄/g, '都営')
    .replace(/京浜急行電鉄/g, '京急')
    .replace(/東武鉄道/g, '東武')
    .replace(/西武鉄道/g, '西武')
    .replace(/京成電鉄/g, '京成')
    .replace(/京王電鉄/g, '京王')
    .replace(/小田急電鉄/g, '小田急')
    .replace(/東急電鉄/g, '東急')
    .replace(/相模鉄道/g, '相鉄')
    .replace(/北総鉄道北総線/g, '北総鉄道')
    .replace(/[ 　]/g, '');
}

let _companyCanon = null;
function lineCompany(line) {
  if (!D.fares) return '';
  if (!_companyCanon) {
    _companyCanon = {};
    for (const [company, data] of Object.entries(D.fares.companies)) {
      for (const name of data.match) _companyCanon[canonLine(name)] = company;
    }
  }
  const c = canonLine(line);
  if (_companyCanon[c]) return _companyCanon[c];
  for (const [name, company] of Object.entries(_companyCanon)) {
    if (c.includes(name) || name.includes(c)) return company;
  }
  // 事業者プレフィクスで判定 (上野東京ライン・京浜東北・根岸線など
  // テーブルの路線名と一致しないＪＲ系統名対策)
  if (/^(ＪＲ|JR)/.test(line)) {
    if (line.includes('東海道新幹線') || line.includes('東海道・山陽')) {
      return D.fares.companies['JR東海'] ? 'JR東海' : 'JR東日本';
    }
    return 'JR東日本';
  }
  if (line.includes('東京メトロ')) return '東京メトロ';
  if (line.includes('都営')) return '都営地下鉄';
  return '';
}

function lookupFare(company, distKm) {
  if (!D.fares) return Math.round(distKm * 25);
  const cd = D.fares.companies[company];
  if (!cd) return Math.round(distKm * (D.fares.default_fare_per_km || 25));
  const km = Math.ceil(distKm); // 運賃計算は営業キロ切り上げ
  for (const [maxDist, fare] of cd.ic_fare) {
    if (km <= maxDist) return fare;
  }
  return cd.ic_fare[cd.ic_fare.length - 1][1];
}

function journeyFare(journey) {
  let total = 0, company = null, dist = 0;
  const breakdown = [];
  for (const leg of journey.legs) {
    if (leg.kind !== 'ride') continue;
    const c = lineCompany(leg.line);
    const km = legKm(leg);
    if (c === company) { dist += km; continue; }
    if (company !== null && dist > 0) {
      const fare = lookupFare(company, dist);
      total += fare; breakdown.push({ company, dist, fare });
    }
    company = c; dist = km;
  }
  if (company !== null && dist > 0) {
    const fare = lookupFare(company, dist);
    total += fare; breakdown.push({ company, dist, fare });
  }
  return { total, breakdown };
}

function journeyKm(journey) {
  let km = 0;
  for (const leg of journey.legs) if (leg.kind === 'ride') km += legKm(leg);
  return km;
}

// --- 複数候補検索 ---
// 1) 最早到着 2) 次発(出発+1) 3) その次 4) 有料優等抜き — を集めて重複排除
function findJourneys(srcIdx, dstIdx, depMin, opts) {
  opts = opts || {};
  const out = [];
  const sigs = new Set();

  function sig(j) {
    return j.legs.map(l => l.kind === 'ride'
      ? `${l.line}:${l.type}:${l.dep}` : `w${l.from}-${l.to}`).join('|');
  }
  function add(j) {
    if (!j) return false;
    const s = sig(j);
    if (sigs.has(s)) return false;
    sigs.add(s);
    out.push(j);
    return true;
  }

  const first = query(srcIdx, dstIdx, depMin, opts);
  if (!first) return out;
  add(first);

  // 次発・次々発
  let t = first.dep + 1;
  for (let i = 0; i < 2; i++) {
    const j = query(srcIdx, dstIdx, t, opts);
    if (!j) break;
    add(j);
    t = j.dep + 1;
  }
  // 優等抜き候補 (firstが有料優等/新幹線を使っている場合)
  const usesPaid = first.legs.some(l => l.kind === 'ride' &&
    (D.tripPaid[l.trip] || D.tripShink[l.trip]));
  if (usesPaid && opts.express !== false) {
    add(query(srcIdx, dstIdx, depMin, Object.assign({}, opts, { express: false, shinkansen: false })));
  }
  // 最初の乗車tripを禁止した別経路
  const ban = new Set([first.legs.find(l => l.kind === 'ride').trip]);
  add(query(srcIdx, dstIdx, depMin, Object.assign({}, opts, { banTrips: ban })));

  // 到着時刻→出発遅い→乗換少ない
  out.sort((a, b) => {
    if (Math.abs(a.arr - b.arr) > 5) return a.arr - b.arr;
    if (Math.abs(b.dep - a.dep) > 5) return b.dep - a.dep;
    return a.transfers - b.transfers;
  });
  return out;
}

const RouterV3 = {
  loadBinary,
  query,
  findJourneys,
  journeyFare,
  journeyKm,
  legKm,
  lineCompany,
  get data() { return D; },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RouterV3;
}
global.RouterV3 = RouterV3;

})(typeof window !== 'undefined' ? window : globalThis);
