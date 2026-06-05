/* router.js — transit-pwa routing core (graph_v2 / train-axis edition).
 *
 * Works in the browser (exposed as window.Router) and in node
 * (module.exports) so the routing logic can be unit-tested offline.
 *
 * graph_v2.json semantics (built by build_graph_trains.py):
 *   edges[idx] = [[toIdx, minutes, line], ...]          local edges
 *                [[toIdx, minutes, line, trainType]]    express skip edges
 *   Weights are REAL median travel minutes from train timetables
 *   (+0.05 tie-break on non-dominant parallel lines).
 *   stations[i].k = ekitan station id = key into timetable.json data.
 */
(function (global) {
'use strict';

const TRANSFER_PENALTY = 6; // minutes: routing cost of changing lines
const TRANSFER_WALK = 3;    // minutes: walk time shown at a real transfer
const RAIL_KM_FACTOR = 1.2; // rail km ≈ straight-line km × 1.2
const KM_PER_MIN = 0.75;    // ~45km/h fallback when coords are missing

// Loaded datasets. Set via Router.setData(key, value).
const D = {
  graph: null,      // graph_v2.json
  freq: null,       // frequency.json
  trainTypes: null, // train_types.json (kept for freq-era line names)
  fares: null,      // fares.json
  timetable: null,  // timetable.json .data (keyed by ekitan id)
  through: new Set(), // canonical "a|b" line pairs with through-service
};

// --- line name normalization across datasets ---
// graph_v2/timetable use ekitan names (ＪＲ常磐線, 都営浅草線, 京急本線),
// fares/frequency/train_types/through_service use older mixed names
// (常磐線, 都営地下鉄浅草線, 京浜急行電鉄本線).
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

function setData(key, value) {
  if (key === 'through') {
    D.through = new Set();
    for (const [a, b] of value.pairs) {
      const ca = canonLine(a), cb = canonLine(b);
      D.through.add(ca + '|' + cb);
      D.through.add(cb + '|' + ca);
    }
    return;
  }
  if (key === 'timetable') { D.timetable = value.data || value; return; }
  D[key] = value;
}

function isThroughService(lineA, lineB) {
  if (!lineA || !lineB || lineA === lineB) return false;
  return D.through.has(canonLine(lineA) + '|' + canonLine(lineB));
}

// --- Dijkstra (per-node label + line-change penalty approximation) ---
function dijkstra(startId, endId, bannedEdges) {
  const graph = D.graph;
  const n = graph.stations.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const prevEdgeLine = new Array(n).fill('');
  const prevEdgeType = new Array(n).fill('');
  const visited = new Uint8Array(n);
  dist[startId] = 0;

  const heap = [[0, startId]];
  function push(d, v) {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[i][0] >= heap[p][0]) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  }
  function pop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        let s = i, l = 2 * i + 1, r = 2 * i + 2;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        [heap[i], heap[s]] = [heap[s], heap[i]];
        i = s;
      }
    }
    return top;
  }

  while (heap.length > 0) {
    const [d, u] = pop();
    if (visited[u]) continue;
    visited[u] = 1;
    if (u === endId) break;

    const neighbors = graph.edges[u];
    if (!neighbors) continue;

    for (const e of neighbors) {
      const v = e[0], w = e[1], line = e[2];
      if (visited[v]) continue;
      if (bannedEdges && bannedEdges.has(u + ':' + v)) continue;

      // Weights are real minutes — no speed-factor correction needed.
      // Penalize line changes unless the two lines run through-service.
      let penalty = 0;
      if (prev[u] !== -1 && prevEdgeLine[u] && line !== prevEdgeLine[u]) {
        if (!isThroughService(prevEdgeLine[u], line)) {
          penalty = TRANSFER_PENALTY;
        }
      }
      const nd = d + w + penalty;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        prevEdgeLine[v] = line;
        prevEdgeType[v] = e[3] || '';
        push(nd, v);
      }
    }
  }

  if (dist[endId] === Infinity) return null;

  const path = [];
  let cur = endId;
  while (cur !== -1) {
    path.unshift({ id: cur, line: prevEdgeLine[cur], type: prevEdgeType[cur] });
    cur = prev[cur];
  }
  return { path, distance: dist[endId] };
}

// --- K alternative routes via spur-point edge banning ---
function findKRoutes(startId, endId, k = 3) {
  const routes = [];

  const first = dijkstra(startId, endId, null);
  if (!first) return routes;
  routes.push(first);

  function routeSignature(route) {
    const segs = detectLineSegments(route.path);
    return segs.map(s => s.line).join('|');
  }
  const seenSignatures = new Set([routeSignature(first)]);

  for (let attempt = 0; attempt < k * 8 && routes.length < k; attempt++) {
    const sourceRoute = routes[attempt % routes.length];
    const pathIds = sourceRoute.path.map(p => p.id);

    const spurIdx = Math.floor((attempt / routes.length + 1) * pathIds.length / (k * 2));
    if (spurIdx <= 0 || spurIdx >= pathIds.length - 1) continue;

    const banned = new Set();
    for (const r of routes) {
      const rIds = r.path.map(p => p.id);
      for (let i = 0; i < rIds.length - 1; i++) {
        if (i < spurIdx && i < pathIds.length - 1 && rIds[i] === pathIds[i]) {
          continue;
        }
        if (i >= spurIdx - 1 && i < spurIdx + 2 && i < rIds.length - 1) {
          banned.add(rIds[i] + ':' + rIds[i + 1]);
          banned.add(rIds[i + 1] + ':' + rIds[i]);
        }
      }
    }

    const alt = dijkstra(startId, endId, banned);
    if (!alt) continue;

    const sig = routeSignature(alt);
    if (seenSignatures.has(sig)) continue;
    if (alt.distance > first.distance * 3) continue;

    seenSignatures.add(sig);
    routes.push(alt);
  }

  return routes;
}

// --- Line segments: group consecutive hops by edge line ---
// v2 edge line labels are accurate (ghost through-service labels dropped at
// build time), so we trust path[i].line directly instead of the old
// shared-station-lines heuristic.
function detectLineSegments(path) {
  const segs = [];
  let cur = null;
  for (let i = 1; i < path.length; i++) {
    const line = path[i].line || '_rail';
    if (!cur || cur.line !== line) {
      if (cur) segs.push(cur);
      cur = { line, from: i - 1, to: i };
    } else {
      cur.to = i;
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

// --- edge / distance helpers ---
function edgeFor(fromId, toId, line) {
  const edges = D.graph.edges[fromId];
  if (!edges) return null;
  let fallback = null;
  for (const e of edges) {
    if (e[0] !== toId) continue;
    if (e[2] === line) return e;
    if (!fallback) fallback = e;
  }
  return fallback;
}

// Real travel minutes over path hops (from+1 .. to), per edge weights.
function segMinutes(path, seg) {
  let total = 0;
  for (let i = seg.from + 1; i <= seg.to; i++) {
    const e = edgeFor(path[i - 1].id, path[i].id, path[i].line);
    total += e ? e[1] : 2;
  }
  return Math.round(total);
}

// Most common express type used on the segment's hops ('' = local).
function segTrainType(path, seg) {
  const counts = {};
  let best = '', bestN = 0;
  for (let i = seg.from + 1; i <= seg.to; i++) {
    const t = path[i].type;
    if (!t) continue;
    counts[t] = (counts[t] || 0) + 1;
    if (counts[t] > bestN) { bestN = counts[t]; best = t; }
  }
  return best;
}

function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371, rad = Math.PI / 180;
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
  const a = Math.sin(dLa / 2) ** 2 +
    Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Estimated rail km over path hops [from..to] (straight-line × factor,
// minutes-based fallback where coords are missing).
function pathKm(path, from, to) {
  const st = D.graph.stations;
  let km = 0;
  for (let i = from + 1; i <= to; i++) {
    const a = st[path[i - 1].id], b = st[path[i].id];
    if (a.la != null && b.la != null) {
      km += haversineKm(a.la, a.lo, b.la, b.lo) * RAIL_KM_FACTOR;
    } else {
      const e = edgeFor(path[i - 1].id, path[i].id, path[i].line);
      km += (e ? e[1] : 2) * KM_PER_MIN;
    }
  }
  return km;
}

// --- frequency fallback (used when no timetable hit) ---
function getTimePeriod(hour) {
  if (hour >= 7 && hour < 9) return 'rush';
  if (hour >= 17 && hour < 19) return 'rush';
  if (hour >= 9 && hour < 17) return 'day';
  if (hour >= 19 && hour < 23) return 'night';
  return 'early';
}

let _freqCanon = null; // canonical line name -> freq entry
function getFrequency(lineName, hour) {
  if (!D.freq) return 10;
  if (!_freqCanon) {
    _freqCanon = {};
    for (const [name, f] of Object.entries(D.freq.lines)) {
      _freqCanon[canonLine(name)] = f;
    }
  }
  const period = getTimePeriod(hour);
  const f = _freqCanon[canonLine(lineName)];
  if (f) return f[period];
  return D.freq.default[period];
}

// --- timetable lookup (keyed by ekitan id via stations[].k) ---
function findNextDeparture(stationIdx, lineName, afterMinutes, towardNames) {
  if (!D.timetable) return null;
  const st = D.graph.stations[stationIdx];
  if (!st || !st.k) return null;
  const dirs = D.timetable[st.k];
  if (!dirs) return null;

  const cLine = canonLine(lineName);
  // Score directions: line must match; prefer a direction whose 「○○方面」
  // mentions a station we are actually heading toward.
  let best = null, bestScore = -1;
  for (const d of dirs) {
    const parts = d.dir.split(/[ 　]+/);
    const dirLine = canonLine(parts[0]);
    if (!(dirLine === cLine || dirLine.includes(cLine) || cLine.includes(dirLine))) continue;
    let score = 1;
    if (towardNames) {
      const rest = parts.slice(1).join('');
      for (const nm of towardNames) {
        if (nm && rest.includes(nm)) { score = 2; break; }
      }
    }
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (!best) return null;

  const deps = best.deps;
  let lo = 0, hi = deps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (deps[mid] < afterMinutes) lo = mid + 1;
    else hi = mid;
  }
  return lo < deps.length ? deps[lo] : null;
}

// --- per-segment dep/arr times ---
function calculateTimes(path, lineSegments, startMinutes) {
  const segTimes = [];
  let currentTime = startMinutes;

  for (let si = 0; si < lineSegments.length; si++) {
    const seg = lineSegments[si];
    const fromStationId = path[seg.from].id;

    const prevSeg = si > 0 ? lineSegments[si - 1] : null;
    const isThrough = prevSeg && isThroughService(prevSeg.line, seg.line);

    // Real timetable first (skip for through-running continuations)
    let depTime = null;
    let usedTimetable = false;

    if (!isThrough || si === 0) {
      const toward = [];
      for (let i = seg.from + 1; i <= seg.to; i++) {
        toward.push(D.graph.stations[path[i].id].n);
      }
      const nextDep = findNextDeparture(fromStationId, seg.line, Math.ceil(currentTime), toward);
      if (nextDep !== null) {
        depTime = nextDep;
        usedTimetable = true;
      }
    }

    // Frequency-based fallback
    if (depTime === null) {
      if (si === 0 || isThrough) {
        depTime = currentTime;
      } else {
        const hour = Math.floor(currentTime / 60) % 24;
        const freq = getFrequency(seg.line, hour);
        depTime = currentTime + Math.round(freq / 2);
      }
    }

    const waitTime = Math.round(depTime - currentTime);
    // Travel time = sum of real edge minutes on this segment
    const travelTime = segMinutes(path, seg);
    const arrTime = depTime + travelTime;

    segTimes.push({
      depTime: Math.round(depTime),
      arrTime: Math.round(arrTime),
      waitTime: Math.max(0, waitTime),
      travelTime,
      trainType: segTrainType(path, seg),
      fromTimetable: usedTimetable,
    });

    currentTime = arrTime;
    if (si < lineSegments.length - 1 && !isThroughService(seg.line, lineSegments[si + 1].line)) {
      currentTime += TRANSFER_WALK;
    }
  }

  return segTimes;
}

// --- fares (distance-based per company; through-service still splits) ---
let _companyCanon = null; // canonical line name -> company
function lineCompany(line) {
  if (!D.fares) return '';
  if (!_companyCanon) {
    _companyCanon = {};
    for (const [company, data] of Object.entries(D.fares.companies)) {
      for (const name of data.match) {
        _companyCanon[canonLine(name)] = company;
      }
    }
  }
  const c = canonLine(line);
  if (_companyCanon[c]) return _companyCanon[c];
  // Substring fallback for naming drift (京浜東北線 vs 京浜東北・根岸線 etc.)
  for (const [name, company] of Object.entries(_companyCanon)) {
    if (c.includes(name) || name.includes(c)) return company;
  }
  return '';
}

function lookupFare(company, distKm) {
  if (!D.fares) return Math.round(distKm * 25);
  const companyData = D.fares.companies[company];
  if (!companyData) return Math.round(distKm * (D.fares.default_fare_per_km || 25));
  const table = companyData.ic_fare;
  for (const [maxDist, fare] of table) {
    if (distKm <= maxDist) return fare;
  }
  return table[table.length - 1][1];
}

function calculateFare(path, lineSegments) {
  if (!D.fares) return null;

  let totalFare = 0;
  const fareBreakdown = [];
  let currentCompany = '';
  let companyDist = 0;

  for (let si = 0; si < lineSegments.length; si++) {
    const seg = lineSegments[si];
    // Unknown companies become 'その他' BEFORE comparison, so the first
    // segment can't silently accumulate under a falsy '' company.
    const company = lineCompany(seg.line) || 'その他';
    const segDistKm = pathKm(path, seg.from, seg.to);

    if (company === currentCompany) {
      companyDist += segDistKm;
    } else {
      if (currentCompany && companyDist > 0) {
        const fare = lookupFare(currentCompany, companyDist);
        totalFare += fare;
        fareBreakdown.push({ company: currentCompany, dist: companyDist, fare });
      }
      currentCompany = company;
      companyDist = segDistKm;
    }
  }

  if (currentCompany && companyDist > 0) {
    const fare = lookupFare(currentCompany, companyDist);
    totalFare += fare;
    fareBreakdown.push({ company: currentCompany, dist: companyDist, fare });
  }

  return { total: totalFare, breakdown: fareBreakdown };
}

const Router = {
  setData,
  canonLine,
  isThroughService,
  dijkstra,
  findKRoutes,
  detectLineSegments,
  segMinutes,
  segTrainType,
  pathKm,
  getFrequency,
  findNextDeparture,
  calculateTimes,
  calculateFare,
  lineCompany,
  _data: D,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Router;
} else {
  global.Router = Router;
}

})(typeof window !== 'undefined' ? window : globalThis);
