#!/usr/bin/env python3
"""
Build timetable_v2.json (ekitan-id keyed, direction-grouped departures)
directly from trains.json (train-axis data, gapfilled).

Why rebuild from trains.json instead of re-keying the old timetable.json
scrape: the phase3 scrape merged both physical directions into a single
「○○方面」 group at some stations (e.g. 高柳 had 312 deps in one
"大宮方面" group, mixing 船橋行 with 柏・大宮行), so the router picked
opposite-direction departures (04:50 船橋行 shown as 柏方面 first train,
real first train is 05:13). trains.json knows each train's actual stop
sequence, so direction grouping is exact.

Direction clustering per (station, line):
  - seed clusters by the train's immediate next stop
  - merge clusters whose "next K stops" windows overlap (local vs express
    of the same physical direction share a major stop within the window;
    K is kept small so loop lines' outer/inner tracks don't merge)

Output: { data: { ekitan_id: [ {dir, via, deps} ] }, stats }
  dir : "ＪＲ山陽・九州新幹線 博多方面" (line + top destinations)
  via : ekitan ids of stops reachable in this direction (window union);
        router matches its toward-stations against this exactly
  deps: sorted departure minutes

Hybrid coverage merge: trains.json misses some trains (e.g. 九州新幹線
through-runs), while the old per-station scrape (timetable.json) has full
deps but unreliable direction grouping. Old deps are merged into a new
cluster only when the direction is provable:
  - the old 「○○方面」 label resolves to stations inside exactly one
    cluster's full downstream set, or
  - the station is a line terminus in graph_v2 (single adjacent station
    on that line = single physical direction)
Old groups for (station, line) pairs absent from trains.json are adopted
as-is (router treats a lone label-only group as usable).
"""

import json
import os
import re
from collections import Counter, defaultdict

BASE = os.path.expanduser('~/transit-pwa')
WINDOW = 8  # next-K stops used for clustering overlap + via


def strip_paren(name):
    return re.sub(r'[（(].*?[)）]$', '', name)


def canon_line(s):
    """Mirror router.js canonLine() so line matching agrees with the client."""
    if not s:
        return ''
    for pat, rep in [('ＪＲ', ''), ('JR', ''), ('東京メトロ', ''),
                     ('都営地下鉄', '都営'), ('京浜急行電鉄', '京急'),
                     ('東武鉄道', '東武'), ('西武鉄道', '西武'),
                     ('京成電鉄', '京成'), ('京王電鉄', '京王'),
                     ('小田急電鉄', '小田急'), ('東急電鉄', '東急'),
                     ('相模鉄道', '相鉄'), ('北総鉄道北総線', '北総鉄道')]:
        s = s.replace(pat, rep)
    return re.sub(r'[ 　]', '', s)


def main():
    with open(os.path.join(BASE, 'trains.json')) as f:
        trains = json.load(f)['trains']

    # (sid, line) -> next_stop_id -> cluster
    # cluster: {'win': set(ids), 'full': set(ids), 'deps': set(min), 'dest': Counter()}
    groups = defaultdict(dict)
    for t in trains:
        line, dest, stops = t['line'], t.get('dest') or '', t['stops']
        for i in range(len(stops) - 1):
            dep = stops[i]['d']
            if dep is None:
                continue
            sid = stops[i]['s']
            rest = [s['s'] for s in stops[i + 1:]]
            cl = groups[(sid, line)].setdefault(
                rest[0], {'win': set(), 'full': set(), 'deps': set(), 'dest': Counter()})
            cl['win'].update(rest[:WINDOW])
            cl['full'].update(rest)
            cl['deps'].add(dep % 1440)
            cl['dest'][dest] += 1

    # merge same-direction clusters (overlapping windows) per (sid, line)
    merged_groups = {}  # (sid, line) -> [cluster]
    for (sid, line), bynext in sorted(groups.items()):
        clusters = list(bynext.values())
        merged = True
        while merged:
            merged = False
            for a in range(len(clusters)):
                for b in range(len(clusters) - 1, a, -1):
                    if clusters[a]['win'] & clusters[b]['win']:
                        for key in ('win', 'full', 'deps'):
                            clusters[a][key] |= clusters[b][key]
                        clusters[a]['dest'] += clusters[b]['dest']
                        del clusters[b]
                        merged = True
        merged_groups[(sid, line)] = clusters

    # --- hybrid coverage merge from the old per-station scrape ---
    with open(os.path.join(BASE, 'ekitan_stations.json')) as f:
        station_map = json.load(f)
    with open(os.path.join(BASE, 'timetable.json')) as f:
        old_tt = json.load(f)['data']
    with open(os.path.join(BASE, 'graph.json')) as f:
        v1 = json.load(f)
    with open(os.path.join(BASE, 'graph_v2.json')) as f:
        v2 = json.load(f)

    # v1 name -> first v1 index with timetable data (phase3 wrote identical
    # entries to every same-named v1 station)
    name_to_gid = {}
    for i, s in enumerate(v1['stations']):
        if s['n'] not in name_to_gid and str(i) in old_tt:
            name_to_gid[s['n']] = str(i)

    # station name (full / paren-stripped / 駅-suffix-stripped) -> ekitan ids,
    # for resolving old 「○○・××方面」 labels (ekitan names are inconsistent:
    # 大宮駅(埼玉) vs 鹿児島中央)
    name_to_sids = defaultdict(set)
    for sid, info in station_map.items():
        name_to_sids[info['name']].add(sid)
        base = strip_paren(info['name'])
        name_to_sids[base].add(sid)
        if base.endswith('駅'):
            name_to_sids[base[:-1]].add(sid)

    # graph_v2 adjacency: ekitan id -> canon line -> distinct neighbor count
    adj = defaultdict(lambda: defaultdict(set))
    for idx, edges in v2['edges'].items():
        k = v2['stations'][int(idx)].get('k')
        if not k:
            continue
        for e in edges:  # [to, minutes, line, (train type?)]
            adj[k][canon_line(e[2])].add(e[0])

    # canon line -> clusters per sid (for matching old groups)
    by_sid_cline = defaultdict(list)  # (sid, cline) -> [(line, cluster)]
    for (sid, line), clusters in merged_groups.items():
        for cl in clusters:
            by_sid_cline[(sid, canon_line(line))].append((line, cl))

    stats_merge = Counter()
    adopted = defaultdict(list)  # sid -> old groups adopted as-is
    for sid, info in station_map.items():
        gid = name_to_gid.get(info['name']) or name_to_gid.get(strip_paren(info['name']))
        if gid is None:
            continue
        for og in old_tt[gid]:
            parts = re.split(r'[ 　]+', og['dir'])
            cline = canon_line(parts[0])
            cands = by_sid_cline.get((sid, cline), [])
            if not cands:
                # no train-axis data for this (station, line): adopt as-is
                adopted[sid].append({'dir': og['dir'], 'deps': og['deps']})
                stats_merge['adopted'] += 1
                continue
            target = None
            if len(cands) == 1 and len(adj.get(sid, {}).get(cline, ())) <= 1:
                # line terminus: single physical direction, merge is safe
                target = cands[0][1]
                stats_merge['terminus'] += 1
            else:
                # resolve label stations to ids; must hit exactly one cluster
                label_ids = set()
                for nm in re.split(r'[・,、]', ''.join(parts[1:]).replace('方面', '')):
                    label_ids |= name_to_sids.get(nm, set())
                hits = [cl for _ln, cl in cands if label_ids & cl['full']]
                if len(hits) == 1:
                    target = hits[0]
                    stats_merge['label'] += 1
                else:
                    stats_merge['skipped'] += 1
            if target is not None:
                # The old scrape sometimes merged both directions into one
                # group (高柳/柏 東武野田線 etc.), so subtract every sibling
                # cluster's minutes first: what remains can only belong to
                # the target direction (costs a few same-minute collisions,
                # never reintroduces opposite-direction departures).
                old_set = {d % 1440 for d in og['deps']}
                for _ln, cl in cands:
                    if cl is not target:
                        old_set -= cl['deps']
                target['deps'] |= old_set

    out = defaultdict(list)
    for (sid, line), clusters in merged_groups.items():
        for cl in clusters:
            total = sum(cl['dest'].values())
            top = cl['dest'].most_common(2)
            label = strip_paren(top[0][0])
            if len(top) > 1 and top[0][1] < total * 0.5:
                second = strip_paren(top[1][0])
                if second != label:
                    label += '・' + second
            out[sid].append({
                'dir': f'{line} {label}方面',
                'via': sorted(cl['win'], key=int),
                'deps': sorted(cl['deps']),
            })
    for sid, glist in adopted.items():
        out[sid].extend(glist)
    print(f"Hybrid merge: {dict(stats_merge)}")

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
    print(f"Stations: {len(out)}, dir-groups: {sum(len(v) for v in out.values())}")
    print(f"Output: {path} ({os.path.getsize(path)/1024/1024:.1f} MB)")
    print(f"Stats: {output['stats']}")


if __name__ == '__main__':
    main()
