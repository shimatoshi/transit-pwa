#!/usr/bin/env python3
"""fix_coords3.py — graph_v2.json に残った座標欠損を wikidata から補完する(第3弾)。

fix_coords.py / fix_coords2.py は wikidata 側の駅名から剥がす事業者プレフィクスを
関東私鉄(京浜急行電鉄/東急電鉄/…)だけに限っていたため、wikidata が
「JR博多駅」「福岡市地下鉄博多駅」のように JR・公営地下鉄の社名を冠している駅を
照合できず座標が null のまま残っていた。

影響: 座標が null の駅を通る経路は journeyKm がその区間を 0km と数えるので、
距離も運賃も壊れる(小倉→博多 が 0.0km / 博多発着の長距離が数百km過少)。

このスクリプトは **座標が欠損している駅だけ** を対象に、
  基準名一致 + 路線canonの重複≥1 (候補が1件なら重複0でも可)
で wikidata と再照合して la/lo を埋める。既存座標は一切書き換えない。

さらに「隣接駅から NEAR_KM 以内」という地理ゲートを掛ける。名前だけで照合すると
広電の江波に福井の江波駅、広電の袋町に新潟の袋町駅の座標が入り、fix_coords2.py が
直したのと同じテレポート経路を作ってしまうため。

Usage: python3 fix_coords3.py [--dry-run]
"""
import json
import math
import os
import re
import sys
import unicodedata

BASE = os.path.dirname(os.path.abspath(__file__))
DRY = '--dry-run' in sys.argv

# wikidata の駅名に前置される事業者名。fix_coords.py の一覧に JR・公営交通を足したもの。
# 長い名前から順に剥がす(「東京都交通局」が「東京都」より先に当たるように)。
NAME_PREFIXES = sorted([
    'ＪＲ', 'JR', '東日本旅客鉄道', '東海旅客鉄道', '西日本旅客鉄道',
    '北海道旅客鉄道', '四国旅客鉄道', '九州旅客鉄道',
    '札幌市営地下鉄', '仙台市地下鉄', '東京地下鉄', '東京メトロ', '都営地下鉄',
    '東京都交通局', '横浜市営地下鉄', '名古屋市営地下鉄', '名古屋市交通局',
    '京都市営地下鉄', '大阪市高速電気軌道', '大阪メトロ', '大阪市営地下鉄',
    '神戸市営地下鉄', '福岡市地下鉄', '福岡市交通局',
    '京浜急行電鉄', '東京モノレール', '東武鉄道', '西武鉄道', '京成電鉄',
    '京王電鉄', '小田急電鉄', '東急電鉄', '相模鉄道', '多摩都市モノレール',
    '名古屋鉄道', '近畿日本鉄道', '南海電気鉄道', '阪急電鉄', '阪神電気鉄道',
    '京阪電気鉄道', '西日本鉄道', '山陽電気鉄道', '神戸電鉄',
], key=len, reverse=True)

LINE_SUBS = (
    ('ＪＲ', ''), ('JR', ''), ('東京地下鉄', ''), ('東京メトロ', ''),
    ('都営地下鉄', '都営'), ('東京都交通局', '都営'),
    ('大阪市高速電気軌道', '大阪メトロ'), ('Osaka Metro', '大阪メトロ'),
    ('京浜急行電鉄', '京急'), ('東武鉄道', '東武'), ('西武鉄道', '西武'),
    ('京成電鉄', '京成'), ('京王電鉄', '京王'), ('小田急電鉄', '小田急'),
    ('東急電鉄', '東急'), ('相模鉄道', '相鉄'),
    ('鉄道', ''), ('電鉄', ''), ('電気軌道', ''), ('株式会社', ''), (' ', ''), ('　', ''),
)


def canon_line(s):
    s = s or ''
    for a, b in LINE_SUBS:
        s = s.replace(a, b)
    return s


def norm(name):
    s = re.sub(r'[（(].*?[)）]', '', name or '')
    s = re.sub(r'駅$', '', s)
    s = unicodedata.normalize('NFKC', s)
    return s.replace('ヶ', 'ケ').replace('ヵ', 'カ')


def base_wd(name):
    """wikidata 側の駅名から事業者プレフィクスを剥がして基準名にする。"""
    s = norm(name)
    for p in NAME_PREFIXES:
        pn = norm(p)
        if pn and s.startswith(pn) and len(s) > len(pn):
            s = s[len(pn):]
            break
    return s


# 隣接駅からこれ以上離れた座標は同名の別地方の駅とみなして採用しない。
# 新幹線の駅間(博多〜小倉 67km)を通せる程度に緩く、県をまたぐ誤爆は落ちる程度に狭く。
NEAR_KM = 80.0


def hav(la1, lo1, la2, lo2):
    R, rad = 6371.0, math.pi / 180
    d1, d2 = (la2 - la1) * rad, (lo2 - lo1) * rad
    a = math.sin(d1 / 2) ** 2 + math.cos(la1 * rad) * math.cos(la2 * rad) * math.sin(d2 / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main():
    G = json.load(open(os.path.join(BASE, 'graph_v2.json')))
    W = json.load(open(os.path.join(BASE, 'wikidata_stations.json')))['stations']

    wd_by_base = {}
    for v in W.values():
        if v.get('lat') is None or v.get('lon') is None:
            continue
        wd_by_base.setdefault(base_wd(v['name']), []).append(v)

    S = G['stations']
    # 隣接駅(既知座標のみ)。地理ゲート用。
    nbr = {}
    for k, arr in G['edges'].items():
        a = int(k)
        for e in arr:
            nbr.setdefault(a, set()).add(e[0])
            nbr.setdefault(e[0], set()).add(a)

    missing = [i for i, s in enumerate(S) if not s.get('m') and s.get('la') is None]
    print(f'座標欠損の鉄道駅: {len(missing)}')

    filled, skipped = 0, []
    for i in missing:
        s = S[i]
        cands = wd_by_base.get(norm(s['n']), [])
        if not cands:
            skipped.append((s['n'], 'wikidataに基準名一致なし'))
            continue
        mine = {canon_line(l) for l in (s.get('l') or [])} | {canon_line(l) for l in (s.get('wl') or [])}
        anchors = [S[j] for j in nbr.get(i, ()) if S[j].get('la') is not None]
        best, best_ov, best_d = None, -1, None
        for c in cands:
            ov = len(mine & {canon_line(l) for l in (c.get('lines') or [])})
            d = min((hav(c['lat'], c['lon'], a['la'], a['lo']) for a in anchors), default=None)
            if d is not None and d > NEAR_KM:
                continue                      # 同名の別地方の駅
            if ov > best_ov:
                best, best_ov, best_d = c, ov, d
        if best is None:
            skipped.append((s['n'], f'候補{len(cands)}件すべて隣接駅から{NEAR_KM:.0f}km超 → 同名の別駅'))
            continue
        if best_ov < 1 and len(cands) > 1 and best_d is None:
            skipped.append((s['n'], f'候補{len(cands)}件で路線重複0・地理照合もできず → 曖昧なので補完しない'))
            continue
        where = f'隣接駅から{best_d:.1f}km' if best_d is not None else '隣接駅の座標なし'
        print(f"  {s['n']:16s} ← {best['name']} ({best['lat']:.5f},{best['lon']:.5f}) 路線重複{best_ov} / {where}")
        s['la'] = round(float(best['lat']), 6)
        s['lo'] = round(float(best['lon']), 6)
        filled += 1

    print(f'\n補完: {filled}駅 / 未補完: {len(skipped)}駅')
    for n, why in skipped:
        print(f'  - {n}: {why}')

    if DRY:
        print('\n--dry-run のため書き込みません')
        return
    # stats.stations がバス停を含まない鉄道駅数なので、with_coords も鉄道駅で数える
    G['stats']['with_coords'] = sum(1 for s in S if not s.get('m') and s.get('la') is not None)
    with open(os.path.join(BASE, 'graph_v2.json'), 'w') as f:
        json.dump(G, f, ensure_ascii=False, separators=(',', ':'))
    print(f"graph_v2.json を更新 (with_coords={G['stats']['with_coords']})")


if __name__ == '__main__':
    main()
