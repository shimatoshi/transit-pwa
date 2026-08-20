#!/usr/bin/env python3
"""qa_components.py — build_graph_trains.py の「最大連結成分だけ残す」処理で
どの路線が丸ごと捨てられているかを検証する(読み取り専用。出力は書かない)。

Usage: python3 qa_components.py [trains.jsonのパス]
"""
import json
import os
import sys
from collections import defaultdict, Counter

TRAINS = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/transit-pwa/trains.json')

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
print(f'最大成分: {len(comps[0])}駅  → build_graph_trains.py はここ以外を全部捨てる')
print(f'捨てられる駅数: {sum(len(c) for c in comps[1:])}')
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
