#!/usr/bin/env python3
"""qa_daytype_match.py — 運転日タグ(tag_calendar.py)の突合が
「再スクレイプが届かなかった」のか「キーが噛み合っていない」のかを切り分ける。

tag_calendar.py の突合キーは tx を '-' で割った 先頭(路線群ID) + 末尾(列車番号)。
再スクレイプは駅ページ単位なので、届いていない路線は路線群IDごと sat/sun 集合に
現れない。逆に路線群IDは出ているのにその路線の列車が1本も当たらないなら、
キーの作りが噛み合っていない(=列車番号が日種別で振り直される等)。

末尾に、tag_calendar.py が実際に使う「路線群ごとの運転本数比 ρ = |土休の番号数| /
|平日の番号数|」の分布も出す。ρ が 0(=スクレイプ未達)と 0.7〜1.3(=実ダイヤの
減便率)に割れていることが、本数ベースで割り当てる根拠になっている。

読み取り専用。Usage: python3 qa_daytype_match.py [trains.jsonのパス]
"""
import json
import os
import sys
from collections import defaultdict

import tag_calendar as T

BASE = os.path.dirname(os.path.abspath(__file__))
TRAINS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE, 'trains.json')


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

# D: tag_calendar.py が実際に使う運転本数比 ρ の分布
sat_core = defaultdict(set)
for k in sat:
    g, tail = k.split('|', 1)
    sat_core[g].add(T.core(tail))
groups = defaultdict(list)
for t in trains:
    groups[(t.get('tx') or '').split('-')[0]].append(t)

hist, htr, low = defaultdict(int), defaultdict(int), []
for g, lst in groups.items():
    n_tails = len({T.core((t.get('tx') or '').split('-')[-1]) for t in lst})
    rho = len(sat_core[g]) / n_tails if (sat_core[g] and n_tails) else 0.0
    b = min(20, int(rho * 10))
    hist[b] += 1
    htr[b] += len(lst)
    if rho < T.MIN_RHO:
        low.append((rho, lst[0]['line'], g, len(lst)))

print('\n=== (D) 路線群ごとの運転本数比 ρ = |土の番号数| / |平日の番号数| ===')
for b in sorted(hist):
    lbl = f'{b*10:3d}-{b*10+10:3d}%' if b < 20 else '   200%+'
    print(f'  {lbl}  路線群{hist[b]:4d}  列車{htr[b]:6d}  {"#" * (hist[b] // 5)}')
print(f'\nρ<{T.MIN_RHO} = 証拠が信用できないと判断して毎日運転に倒す路線群: '
      f'{len(low)}群 {sum(x[3] for x in low)}本')
for rho, L, g, n in sorted(low)[:25]:
    print(f'  {L}  路線群={g}  平日{n}本  ρ={rho:.2f}')
