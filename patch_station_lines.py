#!/usr/bin/env python3
"""graph_v2.json の各駅に wl (Wikidata由来の実乗り入れ路線リスト) を付与する。

目的: 会社跨ぎ直通レグの運賃分割。graph_v2 の l は「停車する列車のラベル路線」
なので直通で汚染される (みなとみらい駅に西武池袋線が入る等)。
Wikidata graph.json の l は駅の実際の接続路線なので所属会社判定に使える。

マッチング: fix_coords.py と同じ正規化 + 座標近接(5km)で同名駅を曖昧性解消。
"""
import json
import math
import re
import unicodedata
from collections import defaultdict

COMPANY_PREFIXES = [
    '京浜急行電鉄', '東京モノレール', '東京地下鉄', '東京メトロ', '東武鉄道',
    '西武鉄道', '京成電鉄', '京王電鉄', '小田急電鉄', '東急電鉄', '相模鉄道',
]

NOISE = re.compile(r'駅百選|^関東の|^東北の|^中部の|^近畿の|停車場|博物館')


def norm(name):
    s = re.sub(r'[（(].*?[)）]$', '', name)
    s = unicodedata.normalize('NFKC', s)
    return s.replace('ヶ', 'ケ').replace('ヵ', 'カ')


def dist2(a, b):
    dla = a[0] - b[0]
    dlo = (a[1] - b[1]) * 0.82
    return dla * dla + dlo * dlo


def main():
    old = json.load(open('graph.json'))
    g2 = json.load(open('graph_v2.json'))

    cands = defaultdict(list)  # norm name -> [(la, lo, lines)]
    for s in old['stations']:
        lines = [l for l in s.get('l', []) if not NOISE.search(l)]
        if not lines:
            continue
        rec = (s.get('la'), s.get('lo'), lines)
        names = {norm(s['n'])}
        for pre in COMPANY_PREFIXES:
            if s['n'].startswith(pre):
                names.add(norm(s['n'][len(pre):]))
        for n in names:
            cands[n].append(rec)

    patched = nohit = ambiguous = 0
    for s in g2['stations']:
        cs = cands.get(norm(s['n']))
        if not cs:
            nohit += 1
            continue
        best = None
        if len(cs) == 1:
            best = cs[0]
        elif s.get('la') is not None:
            # 座標近接で選ぶ (0.05度^2 ≈ 5km四方以内)
            scored = [(dist2((s['la'], s['lo']), (c[0], c[1])), c)
                      for c in cs if c[0] is not None]
            scored.sort(key=lambda x: x[0])
            if scored and scored[0][0] < 0.0025:
                best = scored[0][1]
        if best is None:
            ambiguous += 1
            continue
        s['wl'] = best[2]
        patched += 1

    with open('graph_v2.json', 'w') as f:
        json.dump(g2, f, ensure_ascii=False, separators=(',', ':'))
    print(f'wl patched: {patched}/{len(g2["stations"])}, '
          f'nohit: {nohit}, ambiguous: {ambiguous}')


if __name__ == '__main__':
    main()
