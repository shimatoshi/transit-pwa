#!/usr/bin/env python3
"""qa_daytype_match.py — 運転日タグ(tag_calendar.py)の突合が
「再スクレイプが届かなかった」のか「キーが噛み合っていない」のかを切り分ける。

tag_calendar.py の突合キーは tx を '-' で割った 先頭(路線群ID) + 末尾(列車番号)。
再スクレイプは駅ページ単位なので、届いていない路線は路線群IDごと sat/sun 集合に
現れない。逆に路線群IDは出ているのにその路線の列車が1本も当たらないなら、
キーの作りが噛み合っていない(=列車番号が日種別で振り直される等)。

読み取り専用。Usage: python3 qa_daytype_match.py [trains.jsonのパス]
"""
import json
import os
import sys
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
TRAINS = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/transit-pwa/trains.json')


def key(tx):
    p = tx.split('-')
    return p[0] + '|' + p[-1] if len(p) >= 2 else tx


dt = json.load(open(os.path.join(BASE, 'daytype_keys.json')))
sat, sun = set(dt['sat']), set(dt['sun'])
sat_pref = {k.split('|')[0] for k in sat}
sun_pref = {k.split('|')[0] for k in sun}

trains = json.load(open(TRAINS))['trains']
print(f'trains={len(trains)}  satキー={len(sat)} (路線群{len(sat_pref)})  sunキー={len(sun)} (路線群{len(sun_pref)})')

per = defaultdict(lambda: {'tot': 0, 'hit': 0, 'pref_seen': 0, 'prefs': set()})
tot_hit = 0
for t in trains:
    tx = t.get('tx') or ''
    L = t['line']
    p = per[L]
    p['tot'] += 1
    pref = tx.split('-')[0]
    p['prefs'].add(pref)
    if pref in sat_pref:
        p['pref_seen'] += 1
    if key(tx) in sat:
        p['hit'] += 1
        tot_hit += 1

print(f'キー一致した列車: {tot_hit}/{len(trains)} ({100*tot_hit//max(1,len(trains))}%)')

# A: 路線群IDすら sat 側に無い = 再スクレイプ未達
unreached, keymiss = [], []
for L, p in per.items():
    if p['hit']:
        continue
    (unreached if p['pref_seen'] == 0 else keymiss).append((L, p))

unreached.sort(key=lambda x: -x[1]['tot'])
keymiss.sort(key=lambda x: -x[1]['tot'])
print(f'\n=== (A) 再スクレイプ未達(路線群IDが sat集合に無い): {len(unreached)}路線 '
      f'{sum(p["tot"] for _, p in unreached)}本 ===')
for L, p in unreached[:40]:
    print(f'  {L}  {p["tot"]}本  路線群={sorted(p["prefs"])[:3]}')

print(f'\n=== (B) 路線群は届いているのにキーが1本も当たらない: {len(keymiss)}路線 '
      f'{sum(p["tot"] for _, p in keymiss)}本 ===')
for L, p in keymiss[:40]:
    print(f'  {L}  {p["tot"]}本 (同路線群の便は{p["pref_seen"]}本が既知路線群) 路線群={sorted(p["prefs"])[:3]}')

# C: 部分一致にとどまる路線(一致率が低い順)
part = [(L, p) for L, p in per.items() if 0 < p['hit'] < p['tot'] and p['tot'] >= 30]
part.sort(key=lambda x: x[1]['hit'] / x[1]['tot'])
print(f'\n=== (C) 一致率が低い路線(30本以上): 下位25 ===')
for L, p in part[:25]:
    print(f'  {L}  {p["hit"]}/{p["tot"]} ({100*p["hit"]//p["tot"]}%)  路線群={sorted(p["prefs"])[:3]}')
