#!/usr/bin/env python3
"""qa_components.py — trains.json の連結成分を一覧する(読み取り専用。出力は書かない)。

かつて build_graph_trains.py は最大連結成分だけを残し、本線網と徒歩連絡でしか
繋がらない中小私鉄・モノレール等 40路線514駅 を丸ごと捨てていた (Issue #11)。
現在は全成分を残すので、本スクリプトは「最大成分以外にどんな独立系統があるか」の
観察用。ここに列車の走らないゴミ成分が現れたらデータ異常を疑うこと。

Usage: python3 qa_components.py [trains.jsonのパス]
"""
import json
import os
import sys
from collections import defaultdict, Counter

TRAINS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'trains.json')

trains = json.load(open(TRAINS))['trains']
id2name, id2lines = {}, defaultdict(set)
pairs = set()
for t in trains:
    line = t['line']
    stops = t['stops']
    for s1, s2 in zip(stops, stops[1:]):
        a, b = s1['s'], s2['s']
        if a == b:
            continue
        id2name[a] = s1['n']
        id2name[b] = s2['n']
        id2lines[a].add(line)
        id2lines[b].add(line)
        pairs.add((a, b) if a < b else (b, a))

parent = {k: k for k in id2name}


def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


for a, b in pairs:
    ra, rb = find(a), find(b)
    if ra != rb:
        parent[ra] = rb

comp = defaultdict(list)
for k in id2name:
    comp[find(k)].append(k)
comps = sorted(comp.values(), key=len, reverse=True)
print(f'駅(ekitan id)数: {len(id2name)}  連結成分: {len(comps)}')
print(f'最大成分: {len(comps[0])}駅  (現在は全成分を graph_v2.json に残す)')
print(f'最大成分以外の駅数: {sum(len(c) for c in comps[1:])}')
print()
trip_count = Counter(t['line'] for t in trains)
for c in comps[1:]:
    lines = Counter()
    for k in c:
        for L in id2lines[k]:
            lines[L] += 1
    names = [id2name[k] for k in c]
    print(f'--- {len(c)}駅: {"/".join(sorted(lines))}')
    print(f'    代表駅: {" ".join(names[:8])}{" …" if len(names) > 8 else ""}')
    print(f'    失われる列車: {sum(trip_count[L] for L in lines)}本')
