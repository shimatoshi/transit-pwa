#!/usr/bin/env python3
"""
Re-key timetable.json from v1-graph-index keys to ekitan station ids.

Why: timetable.json (scrape_timetable.py phase3) was keyed by OLD graph.json
station indices. graph_v2.json stations carry `k` (ekitan id), so the natural
join key is the ekitan id. phase3 wrote IDENTICAL entries to every v1 station
sharing a name, so name-level re-keying loses nothing.

ekitan_stations.json: ekitan id -> {name, dirs}  (phase1 output)
timetable.json:       v1 graph index -> [{dir, deps}]
output timetable_v2.json: ekitan id -> [{dir, deps}]
"""

import json
import os
import re

BASE = os.path.expanduser('~/transit-pwa')


def main():
    with open(os.path.join(BASE, 'ekitan_stations.json')) as f:
        station_map = json.load(f)
    with open(os.path.join(BASE, 'timetable.json')) as f:
        old_tt = json.load(f)['data']
    with open(os.path.join(BASE, 'graph.json')) as f:
        v1 = json.load(f)

    # v1 name -> first v1 index that has timetable data
    name_to_gid = {}
    for i, s in enumerate(v1['stations']):
        if s['n'] not in name_to_gid and str(i) in old_tt:
            name_to_gid[s['n']] = str(i)

    out = {}
    matched = unmatched = 0
    for sid, info in station_map.items():
        name = info['name']
        gid = name_to_gid.get(name)
        if gid is None:
            # strip ekitan disambiguation suffix: 札幌(ＪＲ) -> 札幌
            base = re.sub(r'[（(].*?[)）]$', '', name)
            gid = name_to_gid.get(base)
        if gid is None:
            unmatched += 1
            continue
        out[sid] = old_tt[gid]
        matched += 1

    output = {
        'data': out,
        'stats': {
            'stations_with_tt': len(out),
            'total_departures': sum(len(d['deps']) for dl in out.values() for d in dl),
        },
    }
    path = os.path.join(BASE, 'timetable_v2.json')
    with open(path, 'w') as f:
        json.dump(output, f, ensure_ascii=False, separators=(',', ':'))
    print(f"Matched: {matched}, Unmatched: {unmatched}")
    print(f"Output: {path} ({os.path.getsize(path)/1024/1024:.1f} MB)")
    print(f"Stats: {output['stats']}")


if __name__ == '__main__':
    main()
