#!/usr/bin/env python3
"""
Build transit graph from Wikidata station data.
Uses P197 (adjacent station) as primary edges.
Merges with organicmap-plus data for line names.
"""

import json
import math
from collections import defaultdict

WIKIDATA = '/home/transit-pwa/wikidata_stations.json'
ORGANICMAP_INDEX = '/home/organicmap-plus/data/transit/index.json'
OUTPUT = '/home/transit-pwa/graph.json'

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2-lat1), math.radians(lon2-lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def main():
    # Load Wikidata
    with open(WIKIDATA) as f:
        wd = json.load(f)

    stations_raw = wd['stations']  # qid -> {...}
    adjacency = wd['adjacency']    # [(qid, qid)]

    print(f"Wikidata stations: {len(stations_raw)}")
    print(f"Adjacency pairs: {len(adjacency)}")

    # Load organicmap-plus for supplemental data (line names, name_en, pref)
    with open(ORGANICMAP_INDEX) as f:
        om = json.load(f)

    # Build name+location lookup from organicmap for enrichment
    om_lookup = {}
    for s in om['stations']:
        key = (s['name'], round(s['lat'], 2), round(s['lon'], 2))
        om_lookup[key] = s

    # Clean station names: remove "駅" suffix variants, "JR東日本" prefixes, etc.
    import re
    def clean_name(name):
        # Remove company prefixes (longer patterns first to avoid partial match)
        prefixes = [
            '相模鉄道・東急電鉄', '東急電鉄・東京メトロ・都営地下鉄',
            '東急電鉄・東京メトロ', '東急電鉄・横浜高速鉄道',
            '日暮里・舎人ライナー',
            'JR東日本', 'JR西日本', 'JR東海', 'JR北海道', 'JR四国', 'JR九州',
            '東京メトロ', '都営地下鉄', '東急電鉄', '小田急電鉄', '京王電鉄',
            '西武鉄道', '東武鉄道', '京急電鉄', '京成電鉄', '相模鉄道', '相鉄',
            '南海電気鉄道', '近畿日本鉄道', '阪急電鉄', '阪神電気鉄道',
            '名古屋鉄道', '西日本鉄道', '大阪メトロ', '京阪電気鉄道',
        ]
        n = name
        # Try stripping company prefixes (may be joined by ・)
        changed = True
        while changed:
            changed = False
            n = n.lstrip('・')
            for p in prefixes:
                if n.startswith(p):
                    n = n[len(p):]
                    changed = True
                    break
        # Remove trailing "駅" and parenthetical suffixes like "駅 (JR西日本)"
        n = re.sub(r'\s*[\(（].*?[\)）]\s*$', '', n)
        n = re.sub(r'駅$', '', n)
        n = re.sub(r'\s*(信号場|停留場)\s*$', '', n)
        return n.strip()

    # Deduplicate: group by clean_name + proximity
    # Multiple Wikidata entities for the same physical station
    name_groups = defaultdict(list)
    for qid, s in stations_raw.items():
        cn = clean_name(s['name'])
        name_groups[cn].append(qid)

    # Merge nearby same-name stations
    merged = {}  # canonical_qid -> station_data
    qid_to_canonical = {}  # any_qid -> canonical_qid

    for cn, qids in name_groups.items():
        if len(qids) == 1:
            qid = qids[0]
            s = stations_raw[qid]
            merged[qid] = {
                'name': cn,
                'lat': s['lat'], 'lon': s['lon'],
                'lines': list(s['lines']),
                'raw_qids': [qid],
            }
            qid_to_canonical[qid] = qid
        else:
            # Group by proximity (500m clusters)
            clusters = []
            for qid in qids:
                s = stations_raw[qid]
                placed = False
                for cluster in clusters:
                    rep = stations_raw[cluster[0]]
                    if haversine(s['lat'], s['lon'], rep['lat'], rep['lon']) < 500:
                        cluster.append(qid)
                        placed = True
                        break
                if not placed:
                    clusters.append([qid])

            for cluster in clusters:
                # Pick the one with most adjacency connections as canonical
                adj_count = {}
                for s_qid, a_qid in adjacency:
                    if s_qid in cluster:
                        adj_count[s_qid] = adj_count.get(s_qid, 0) + 1
                best = max(cluster, key=lambda q: (adj_count.get(q, 0), len(stations_raw[q]['lines'])))
                s = stations_raw[best]
                all_lines = []
                for q in cluster:
                    for l in stations_raw[q]['lines']:
                        if l not in all_lines:
                            all_lines.append(l)

                # Average coordinates
                avg_lat = sum(stations_raw[q]['lat'] for q in cluster) / len(cluster)
                avg_lon = sum(stations_raw[q]['lon'] for q in cluster) / len(cluster)

                merged[best] = {
                    'name': cn,
                    'lat': avg_lat, 'lon': avg_lon,
                    'lines': all_lines,
                    'raw_qids': cluster,
                }
                for q in cluster:
                    qid_to_canonical[q] = best

    print(f"Merged stations: {len(merged)}")

    # Build edges from adjacency
    edge_set = set()  # (canonical_a, canonical_b)
    skipped = 0
    for s_qid, a_qid in adjacency:
        if s_qid not in qid_to_canonical or a_qid not in qid_to_canonical:
            skipped += 1
            continue
        ca = qid_to_canonical[s_qid]
        cb = qid_to_canonical[a_qid]
        if ca == cb:
            continue
        pair = (min(ca, cb), max(ca, cb))
        edge_set.add(pair)

    print(f"Edges from adjacency: {len(edge_set)} (skipped {skipped} missing)")

    # Enrich with organicmap data
    for qid, s in merged.items():
        key = (s['name'], round(s['lat'], 2), round(s['lon'], 2))
        om_match = om_lookup.get(key)
        if om_match:
            s['name_en'] = om_match.get('name_en', '')
            s['pref'] = om_match.get('pref', '')
            # Add lines from organicmap
            for l in om_match.get('lines', []):
                if l not in s['lines']:
                    s['lines'].append(l)
        else:
            s['name_en'] = ''
            s['pref'] = ''

    # Try to assign pref from coordinates for stations without pref
    # Simple bounding boxes for major prefectures
    # (skip for now, pref is nice-to-have)

    # Assign numeric IDs
    qid_list = sorted(merged.keys())
    qid_to_id = {q: i for i, q in enumerate(qid_list)}

    # Build graph output
    station_list = []
    for qid in qid_list:
        s = merged[qid]
        station_list.append({
            'n': s['name'],
            'e': s.get('name_en', ''),
            'la': round(s['lat'], 5),
            'lo': round(s['lon'], 5),
            'p': s.get('pref', ''),
            'l': s['lines'],
        })

    # Build edge list
    edge_list = defaultdict(list)
    for ca, cb in edge_set:
        if ca not in qid_to_id or cb not in qid_to_id:
            continue
        a_id = qid_to_id[ca]
        b_id = qid_to_id[cb]
        sa = merged[ca]
        sb = merged[cb]
        dist = round(haversine(sa['lat'], sa['lon'], sb['lat'], sb['lon']))

        # Try to determine line name
        common_lines = [l for l in sa['lines'] if l in sb['lines']]
        line_name = common_lines[0] if common_lines else '_rail'

        edge_list[a_id].append([b_id, dist, line_name])
        edge_list[b_id].append([a_id, dist, line_name])

    # Find connected components
    parent = list(range(len(station_list)))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a, b):
        a, b = find(a), find(b)
        if a != b: parent[a] = b

    for sid, neighbors in edge_list.items():
        for nid, _, _ in neighbors:
            union(sid, nid)

    components = defaultdict(list)
    for i in range(len(station_list)):
        if i in edge_list or any(i in [n[0] for n in edge_list.get(j, [])] for j in []):
            components[find(i)].append(i)

    # Recount properly
    connected = set()
    for sid, neighbors in edge_list.items():
        connected.add(sid)
        for nid, _, _ in neighbors:
            connected.add(nid)

    comp_map = defaultdict(list)
    for sid in connected:
        comp_map[find(sid)].append(sid)

    biggest = max(comp_map.values(), key=len) if comp_map else []
    biggest_set = set(biggest)

    print(f"Connected stations: {len(connected)}")
    print(f"Components: {len(comp_map)}")
    print(f"Biggest component: {len(biggest)} stations")

    # Remap to only include biggest component
    new_station_list = []
    old_to_new = {}
    for old_id in sorted(biggest_set):
        old_to_new[old_id] = len(new_station_list)
        new_station_list.append(station_list[old_id])

    new_edge_list = {}
    for old_id in biggest_set:
        new_id = old_to_new[old_id]
        remapped = []
        for nid, dist, line in edge_list.get(old_id, []):
            if nid in old_to_new:
                remapped.append([old_to_new[nid], dist, line])
        if remapped:
            new_edge_list[new_id] = remapped

    all_lines = sorted(set(
        line for s in new_station_list for line in s['l']
    ))

    output = {
        'stations': new_station_list,
        'edges': new_edge_list,
        'lines': all_lines,
        'stats': {
            'stations': len(new_station_list),
            'lines': len(all_lines),
            'edges': sum(len(v) for v in new_edge_list.values()) // 2,
        }
    }

    with open(OUTPUT, 'w') as f:
        json.dump(output, f, ensure_ascii=False, separators=(',', ':'))

    import os
    size = os.path.getsize(OUTPUT)
    print(f"\nOutput: {OUTPUT} ({size/1024:.0f} KB)")
    print(f"Stations: {output['stats']['stations']}")
    print(f"Lines: {output['stats']['lines']}")
    print(f"Edges: {output['stats']['edges']}")

    # Verification
    print("\n=== Verification ===")
    def find_by_name(name):
        results = []
        for i, s in enumerate(new_station_list):
            if s['n'] == name:
                results.append(i)
        return results

    for name in ['渋谷', '池袋', '新宿', '東京', '横浜', '名古屋', '大阪', '京都', '博多', '札幌']:
        ids = find_by_name(name)
        if ids:
            sid = ids[0]
            n_edges = len(new_edge_list.get(sid, []))
            neighbors = [new_station_list[e[0]]['n'] for e in new_edge_list.get(sid, [])[:5]]
            print(f"  {name}: edges={n_edges}, neighbors={neighbors}")
        else:
            print(f"  {name}: NOT FOUND")

if __name__ == '__main__':
    main()
