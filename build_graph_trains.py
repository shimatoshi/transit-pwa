#!/usr/bin/env python3
"""
Build transit graph from trains.json (train-axis timetable data).

Why: the old build_graph.py derived edges from Wikidata P197 adjacency, which is
incomplete (e.g. Tsukuba Express dead-ends at Kita-senju) and mislabels lines.
trains.json contains real train stop sequences with arrival/departure times, so
consecutive stops give us correct topology, correct line names, and REAL travel
times.

Output graph_v2.json schema (compatible-ish with graph.json):
  stations: [{n, e, la, lo, p, l, k}]   # k = ekitan station id
  edges:    {idx: [[to_idx, minutes, line], ...]}   # weight is real travel minutes
            express skip edges carry a 4th element: the train type (特急/快速/...)
  lines:    [...]
  stats:    {...}

Edges are kept per (station-pair, line) so parallel lines sharing a station pair
(e.g. TX / Hibiya / Joban all linking Kita-senju-Minami-senju) are NOT collapsed.
A small tie-break penalty biases routing toward the line that runs the most trains
on a given pair, which suppresses through-service "ghost" labels in the output.
"""

import json
import os
import re
import statistics
from collections import defaultdict, Counter

BASE = os.path.expanduser('~/transit-pwa')
TRAINS = os.path.join(BASE, 'trains.json')
OLD_GRAPH = os.path.join(BASE, 'graph.json')
OUTPUT = os.path.join(BASE, 'graph_v2.json')

# A median travel time outside this range (minutes) is treated as bad data.
MIN_DT, MAX_DT = 1, 240
DEFAULT_DT = 2  # fallback when no arr/dep pair was available for a segment
# A line whose train count on a pair is below this fraction of the pair's
# busiest line is treated as a through-service "ghost" label and dropped.
# The busiest (native) line always survives, so connectivity is never lost.
GHOST_FRAC = 0.15

# Train types that stop at every station -> define the base topology.
# Anything else is an express/limited service layered on top.
LOCAL_TYPES = {'各停', '各駅停車', '普通', '普通車', ''}

# Express (non-local) edges are kept only if at least this many express trains
# traverse the pair. This drops once-or-twice-a-day long-distance trains
# (e.g. 寝台特急サンライズ, サフィール踊り子) that would otherwise create
# unrealistic skip shortcuts, while keeping frequent 特急/快速/急行 as fast
# options. Local edges are NEVER frequency-filtered (rural lines run few trains).
MIN_EXPRESS = 8


def main():
    with open(TRAINS) as f:
        trains = json.load(f)['trains']
    print(f"Trains: {len(trains)}")

    # --- collect nodes, edge travel times, and per-pair line vote counts ---
    id2name = {}
    id2lines = defaultdict(set)
    # key (min,max,line) -> list of travel minutes
    seg_times = defaultdict(list)
    # unordered pair (min,max) -> Counter(line -> #traversals)  (all trains)
    pair_votes = defaultdict(Counter)
    # (pair, line) seen on a local (all-stop) train -> defines base topology
    local_seg = set()
    # (pair, line) -> #express trains (for the MIN_EXPRESS frequency filter)
    exp_count = defaultdict(int)
    # (pair, line) -> Counter(train type) among express trains, so skip edges
    # can be labeled with their real service type (特急/快速/急行/...)
    exp_types = defaultdict(Counter)

    for t in trains:
        line = t['line']
        ttype = t.get('type', '')
        is_local = ttype in LOCAL_TYPES
        stops = t['stops']
        for i in range(len(stops) - 1):
            s1, s2 = stops[i], stops[i + 1]
            a, b = s1['s'], s2['s']
            if a == b:
                continue
            id2name[a] = s1['n']
            id2name[b] = s2['n']
            id2lines[a].add(line)
            id2lines[b].add(line)
            lo, hi = (a, b) if a < b else (b, a)
            pair_votes[(lo, hi)][line] += 1
            if is_local:
                local_seg.add((lo, hi, line))
            else:
                exp_count[(lo, hi, line)] += 1
                exp_types[(lo, hi, line)][ttype] += 1
            if s1['d'] is not None and s2['a'] is not None:
                dt = s2['a'] - s1['d']
                if MIN_DT <= dt <= MAX_DT:
                    seg_times[(lo, hi, line)].append(dt)

    print(f"Unique stations (ekitan ids): {len(id2name)}")
    print(f"Local (all-stop) segment+line keys: {len(local_seg)}")

    # --- enrich coords/pref from old graph by name (best effort) ---
    # Homonym stations (上野 in Tokyo vs Toyama etc.) are disambiguated by
    # canonical line-name overlap; with no overlap and multiple candidates we
    # leave coords empty rather than risk a 600km-off match.
    def canon(s):
        for a, b in (('ＪＲ', ''), ('JR', ''), ('東京メトロ', ''),
                     ('都営地下鉄', '都営'), ('京浜急行電鉄', '京急'),
                     ('東武鉄道', '東武'), ('西武鉄道', '西武'),
                     ('京成電鉄', '京成'), ('京王電鉄', '京王'),
                     ('小田急電鉄', '小田急'), ('東急電鉄', '東急'),
                     ('相模鉄道', '相鉄')):
            s = s.replace(a, b)
        return s

    name2cands = defaultdict(list)  # name -> [(la, lo, p, e, canon_lines)]
    try:
        with open(OLD_GRAPH) as f:
            old = json.load(f)
        for s in old['stations']:
            cl = {canon(l) for l in s.get('l', [])}
            name2cands[s['n']].append((s.get('la'), s.get('lo'), s.get('p', ''), s.get('e', ''), cl))
        print(f"Old graph names for geo enrichment: {len(name2cands)}")
    except FileNotFoundError:
        print("WARN: old graph.json not found, stations will lack coords")

    def lookup_geo(name, lines):
        cands = name2cands.get(name)
        if not cands:
            # ekitan disambiguation suffixes: 札幌(ＪＲ), 浅草(ＴＸ) etc.
            base = re.sub(r'[（(].*?[)）]$', '', name)
            cands = name2cands.get(base)
        if not cands:
            return (None, None, '', '')
        if len(cands) == 1:
            return cands[0][:4]
        cl = {canon(l) for l in lines}
        best, best_score = None, 0
        for c in cands:
            score = sum(1 for a in cl for b in c[4]
                        if a == b or (a and b and (a in b or b in a)))
            if score > best_score:
                best, best_score = c, score
        return best[:4] if best else (None, None, '', '')

    # --- assign compact indices (sorted by ekitan id for determinism) ---
    ekitan_ids = sorted(id2name.keys(), key=lambda x: int(x))
    eid_to_idx = {eid: i for i, eid in enumerate(ekitan_ids)}

    stations = []
    for eid in ekitan_ids:
        nm = id2name[eid]
        la, lo, pref, en = lookup_geo(nm, id2lines[eid])
        stations.append({
            'n': nm,
            'e': en,
            'la': la,
            'lo': lo,
            'p': pref,
            'l': sorted(id2lines[eid]),
            'k': eid,  # ekitan station id (for timetable / trains lookups)
        })

    # --- build edges per (pair, line) with real median travel time ---
    # dominant line per pair (most train traversals) gets no tie-break penalty;
    # other parallel lines get a tiny +0.05 so routing prefers the native line.
    dominant = {pair: votes.most_common(1)[0][0] for pair, votes in pair_votes.items()}

    def is_ghost(pair, line):
        votes = pair_votes[pair]
        top = votes.most_common(1)[0][1]
        return votes[line] < GHOST_FRAC * top

    edges = defaultdict(list)
    edge_count = 0
    ghost_dropped = 0
    rare_express_dropped = 0
    express_kept = 0
    # Rare-express edges that were dropped below; kept aside as last-resort
    # connectors. Each: (weight, ai, bi, line). After the main graph is built
    # we re-add only the ones that bridge otherwise-disconnected components
    # (Kruskal-style), so sparse lines whose ONLY service is an infrequent
    # express (五能線 リゾートしらかみ, 日南線, etc.) stay reachable, while
    # redundant shortcuts (Tokyo-Yokohama by the nightly Sunrise, whose ends
    # are already linked via the local corridor) do NOT come back.
    rare_edges = []
    # Emit a (pair, line) edge if it is either:
    #   - a LOCAL edge (all-stop train ran it) -> base topology, always kept, OR
    #   - an EXPRESS edge with >= MIN_EXPRESS trains -> frequent fast option.
    # Through-service ghost labels are dropped in both cases.
    for (lo, hi), votes in pair_votes.items():
        top_line = dominant[(lo, hi)]
        for line in votes:
            local = (lo, hi, line) in local_seg
            times = seg_times.get((lo, hi, line))
            med = round(statistics.median(times)) if times else DEFAULT_DT
            # tiny tie-break so routing prefers the busiest line on the pair
            w = med + (0.0 if line == top_line else 0.05)
            ai, bi = eid_to_idx[lo], eid_to_idx[hi]
            etype = ''
            if not local:
                tc = exp_types.get((lo, hi, line))
                etype = tc.most_common(1)[0][0] if tc else '優等'
                # express layer: require enough trains, else it's a rare
                # long-distance shortcut (sleeper, seasonal ltd express).
                # Defer it as a connectivity-completion candidate rather than
                # emitting it as a routable fast option.
                if exp_count[(lo, hi, line)] < MIN_EXPRESS:
                    rare_express_dropped += 1
                    rare_edges.append((w, ai, bi, line, etype))
                    continue
            # drop through-service ghost labels (the dominant line, having the
            # top vote count, is by definition never a ghost)
            if is_ghost((lo, hi), line):
                ghost_dropped += 1
                continue
            if local:
                edges[ai].append([bi, w, line])
                edges[bi].append([ai, w, line])
            else:
                edges[ai].append([bi, w, line, etype])
                edges[bi].append([ai, w, line, etype])
                express_kept += 1
            edge_count += 1

    print(f"Edges (undirected): {edge_count}  "
          f"[express kept: {express_kept}, rare-express dropped: {rare_express_dropped}, "
          f"ghost dropped: {ghost_dropped}]")

    # --- keep biggest connected component ---
    parent = list(range(len(stations)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for ai, nbrs in edges.items():
        for e in nbrs:
            union(ai, e[0])

    # Connectivity completion: re-add a dropped rare express only when it joins
    # two components that the kept edges left separate. Cheapest first, so the
    # fastest available connector wins when several would bridge the same gap.
    rare_readded = 0
    rare_edges.sort(key=lambda e: e[0])
    for w, ai, bi, line, etype in rare_edges:
        if find(ai) != find(bi):
            union(ai, bi)
            edges[ai].append([bi, w, line, etype])
            edges[bi].append([ai, w, line, etype])
            edge_count += 1
            rare_readded += 1
    print(f"Rare-express re-added for connectivity: {rare_readded}")

    comp = defaultdict(list)
    for i in range(len(stations)):
        comp[find(i)].append(i)
    biggest = max(comp.values(), key=len)
    biggest_set = set(biggest)
    print(f"Components: {len(comp)}, biggest: {len(biggest)} stations")

    # --- remap to biggest component ---
    old_to_new = {}
    new_stations = []
    for old_i in sorted(biggest_set):
        old_to_new[old_i] = len(new_stations)
        new_stations.append(stations[old_i])

    new_edges = {}
    for old_i in biggest_set:
        ni = old_to_new[old_i]
        remapped = [[old_to_new[e[0]], *e[1:]] for e in edges.get(old_i, []) if e[0] in old_to_new]
        if remapped:
            new_edges[ni] = remapped

    all_lines = sorted(set(line for s in new_stations for line in s['l']))
    with_geo = sum(1 for s in new_stations if s['la'] is not None)

    out = {
        'stations': new_stations,
        'edges': new_edges,
        'lines': all_lines,
        'stats': {
            'stations': len(new_stations),
            'lines': len(all_lines),
            'edges': sum(len(v) for v in new_edges.values()) // 2,
            'with_coords': with_geo,
        },
    }
    with open(OUTPUT, 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    size = os.path.getsize(OUTPUT)
    print(f"\nOutput: {OUTPUT} ({size/1024:.0f} KB)")
    print(f"Stats: {out['stats']}")


if __name__ == '__main__':
    main()
