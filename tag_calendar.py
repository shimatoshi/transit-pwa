#!/usr/bin/env python3
"""tag_calendar.py — daytype_keys.json(土/休の運転列車キー)で trains.json に運転日 cal を付与。
bit0=平日(1) bit1=土曜 bit2=休日。

突合は安定キー(tx先頭=路線群 + tx末尾=列車番号)で行う。ekitanの内部tx中間IDは
日次で変わるためフルtxでは一致しない(列車番号は安定で武蔵野線266本100%一致を確認済)。
"""
import json, os
BASE = os.path.dirname(os.path.abspath(__file__))


def key(tx):
    p = tx.split('-')
    return p[0] + '|' + p[-1] if len(p) >= 2 else tx


dt = json.load(open(os.path.join(BASE, 'daytype_keys.json')))
sat = set(dt['sat'])
sun = set(dt['sun'])

data = json.load(open(os.path.join(BASE, 'trains.json')))
trains = data['trains']
hist = {}
for t in trains:
    k = key(t['tx'])
    cal = 1                      # 平日(既存データ=平日)
    if k in sat:
        cal |= 2
    if k in sun:
        cal |= 4
    t['cal'] = cal
    hist[cal] = hist.get(cal, 0) + 1

data.setdefault('stats', {})['calendar'] = hist
json.dump(data, open(os.path.join(BASE, 'trains.json'), 'w'), ensure_ascii=False, separators=(',', ':'))

names = {1: '平日のみ', 3: '平日+土', 5: '平日+休', 7: '毎日', 2: '土のみ', 4: '休のみ', 6: '土休のみ'}
print('運転日タグ付け完了:')
for kk in sorted(hist):
    print(f'  cal={kk} ({names.get(kk, "?")}): {hist[kk]}本')
wd_only = hist.get(1, 0)
print(f'平日のみ率: {100*wd_only//len(trains)}% (低いほど良い。高すぎるとカバレッジ不足)')
