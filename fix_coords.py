#!/usr/bin/env python3
"""graph_v2.json の座標欠損駅を graph.json(Wikidata由来) から正規化マッチで補完する。

欠損原因 = 表記揺れ:
- ヶ/ケ, ヵ/カ (駅探=ケ, Wikidata=ヶ)
- 全角数字/半角数字 (第１・第２ ↔ 第1・第2)
- 会社名プレフィクス (京浜急行電鉄羽田空港第3ターミナル ↔ 羽田空港第３ターミナル(京急))

同名駅の曖昧性は build_graph_trains.py と同じ路線重なりスコアで解消。
曖昧なまま(候補複数・路線重なりゼロ)は補完しない。
"""
import json
import re
import unicodedata
from collections import defaultdict

COMPANY_PREFIXES = [
    '京浜急行電鉄', '東京モノレール', '東京地下鉄', '東京メトロ', '東武鉄道',
    '西武鉄道', '京成電鉄', '京王電鉄', '小田急電鉄', '東急電鉄', '相模鉄道',
]


def canon_line(s):
    for a, b in (('ＪＲ', ''), ('JR', ''), ('東京メトロ', ''),
                 ('都営地下鉄', '都営'), ('京浜急行電鉄', '京急'),
                 ('東武鉄道', '東武'), ('西武鉄道', '西武'),
                 ('京成電鉄', '京成'), ('京王電鉄', '京王'),
                 ('小田急電鉄', '小田急'), ('東急電鉄', '東急'),
                 ('相模鉄道', '相鉄')):
        s = s.replace(a, b)
    return s


def norm(name):
    s = re.sub(r'[（(].*?[)）]$', '', name)  # 曖昧性サフィックス除去
    s = unicodedata.normalize('NFKC', s)     # 全角数字→半角 等
    s = s.replace('ヶ', 'ケ').replace('ヵ', 'カ')
    return s


def main():
    old = json.load(open('graph.json'))
    g2 = json.load(open('graph_v2.json'))

    cands = defaultdict(list)  # norm name -> [(la, lo, p, cl)]
    for s in old['stations']:
        if s.get('la') is None:
            continue
        cl = {canon_line(l) for l in s.get('l', [])}
        rec = (s['la'], s['lo'], s.get('p', ''), cl)
        names = {norm(s['n'])}
        for pre in COMPANY_PREFIXES:
            if s['n'].startswith(pre):
                names.add(norm(s['n'][len(pre):]))
        for n in names:
            cands[n].append(rec)

    patched, ambiguous, nohit = 0, [], []
    for s in g2['stations']:
        if s.get('la') is not None:
            continue
        cs = cands.get(norm(s['n']))
        if not cs:
            nohit.append(s['n'])
            continue
        # 駅探サフィックス「(宮城)」「(千葉)」等は都道府県ヒント
        m = re.search(r'[（(](.+?)[)）]$', s['n'])
        if m and len(cs) > 1:
            hint = m.group(1)
            by_pref = [c for c in cs if hint and hint in (c[2] or '')]
            if by_pref:
                cs = by_pref
        if len(cs) == 1:
            best = cs[0]
        else:
            cl = {canon_line(l) for l in s.get('l', [])}
            best, score = None, 0
            for c in cs:
                sc = sum(1 for a in cl for b in c[3]
                         if a == b or (a and b and (a in b or b in a)))
                if sc > score:
                    best, score = c, sc
            if best is None:
                ambiguous.append(s['n'])
                continue
        s['la'], s['lo'] = best[0], best[1]
        if not s.get('p'):
            s['p'] = best[2]
        patched += 1

    missing = sum(1 for s in g2['stations'] if s.get('la') is None)
    g2['stats']['with_coords'] = len(g2['stations']) - missing
    with open('graph_v2.json', 'w') as f:
        json.dump(g2, f, ensure_ascii=False, separators=(',', ':'))
    print(f"patched: {patched}, still missing: {missing}")
    print(f"ambiguous (skipped): {len(ambiguous)} {ambiguous[:10]}")
    print(f"no candidate: {len(nohit)} {nohit[:20]}")


if __name__ == '__main__':
    main()
