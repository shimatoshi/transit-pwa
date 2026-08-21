#!/usr/bin/env python3
"""fix_daytype_meta.py — trains_v3_meta.json の trips.c に、tag_calendar.py と同じ
「土休の証拠が1件も無い鉄道路線は毎日運転として残す」フォールバックを適用する。

tag_calendar.py 側を直しても trains.json からの再ビルド(make_trains_v3.py)が要る。
trains.json は 114MB でリポジトリに入っていないため、既にビルド済みの
trains_v3_meta.json に同じ規則を後掛けする。trips.c は meta にしか無いので
trains_v3.bin の再生成は不要。

バス(trips.m == 1)は GTFS の calendar から正しい運転日が入っているので触らない。

Usage: python3 fix_daytype_meta.py [--dry-run]
"""
import json
import os
import sys
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
DRY = '--dry-run' in sys.argv
MP = os.path.join(BASE, 'trains_v3_meta.json')

meta = json.load(open(MP))
cal = meta['trips']['c']
line_of = meta['trips']['l']
mode_of = meta['trips'].get('m')
lines = meta['lines']

weekend_hits = defaultdict(int)
total = defaultdict(int)
for t, c in enumerate(cal):
    if mode_of and mode_of[t] == 1:      # バスは GTFS 由来。触らない
        continue
    L = lines[line_of[t]]
    total[L] += 1
    if c & 6:
        weekend_hits[L] += 1

no_evidence = sorted((L for L in total if weekend_hits[L] == 0), key=lambda x: -total[x])
print(f'土休の証拠が1件も無い鉄道路線: {len(no_evidence)}路線')
for L in no_evidence:
    print(f'  {L}  {total[L]}本')

changed = 0
for t in range(len(cal)):
    if mode_of and mode_of[t] == 1:
        continue
    if lines[line_of[t]] in set(no_evidence) and cal[t] != 7:
        cal[t] = 7
        changed += 1
print(f'\n{changed}本を cal=7(毎日) に戻した')

hist = defaultdict(int)
for c in cal:
    hist[c] += 1
print('適用後の分布: ' + ' '.join(f'bits={k}:{v}' for k, v in sorted(hist.items())))

if DRY:
    print('--dry-run: 書き込みなし')
else:
    json.dump(meta, open(MP, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(f'書き込み: {MP}')
