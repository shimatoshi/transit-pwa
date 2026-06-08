#!/usr/bin/env python3
"""fix_coords2.py — graph_v2.json の座標汚染を wikidata から再ジオコーディングして修復。

build_graph_trains.py の lookup_geo フォールバックは、サフィックス都道府県を無視して
別都市の同名駅座標を流用していた(例: 中島(愛知) に 中島(広島) の座標)。同一座標は
make_trains_v3.py の徒歩連絡(同名≤1.2km / 近接≤400m)を経由してテレポート経路を生む。

対策: 各駅を wikidata(stations) から「基準名一致 + 路線canon重複≥1」で再照合し、
2km以上ずれていれば正しい座標へ更新。欠損も補完。路線重複ゲートで誤爆を防ぐ。
その後 make_trains_v3.py を再実行すれば徒歩連絡が正しい距離で再生成される。
"""
import json, re, math, unicodedata
from collections import defaultdict

G = json.load(open('graph_v2.json'))
S = G['stations']
W = json.load(open('wikidata_stations.json'))['stations']


def canon_line(s):
    s = s or ''
    s = (s.replace('ＪＲ', '').replace('JR', '')
          .replace('東京地下鉄', '東京メトロ').replace('東京メトロ', '')
          .replace('都営地下鉄', '都営').replace('東京都交通局', '都営')
          .replace('大阪市高速電気軌道', '大阪メトロ').replace('Osaka Metro', '大阪メトロ')
          .replace('鉄道', '').replace('電鉄', '').replace('電気軌道', '')
          .replace('株式会社', '').replace(' ', '').replace('　', ''))
    return s


def basename(n):
    n = re.sub(r'[（(].*?[)）]', '', n)
    n = re.sub(r'駅$', '', n)
    n = unicodedata.normalize('NFKC', n).replace('ヶ', 'ケ').replace('ヵ', 'カ')
    return n


def hav(la1, lo1, la2, lo2):
    R, rad = 6371.0, math.pi / 180
    d1, d2 = (la2 - la1) * rad, (lo2 - lo1) * rad
    a = math.sin(d1 / 2) ** 2 + math.cos(la1 * rad) * math.cos(la2 * rad) * math.sin(d2 / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


widx = defaultdict(list)
for v in W.values():
    bn = basename(v['name'])
    cl = {canon_line(l) for l in (v.get('lines') or [])}
    widx[bn].append((v['lat'], v['lon'], cl, v['name']))


def best_wd(st):
    cands = widx.get(basename(st['n']))
    if not cands:
        return None
    cl = {canon_line(l) for l in (st.get('l') or [])}
    cl.discard('')
    best, bs = None, 0
    for la, lo, wcl, wn in cands:
        sc = len(cl & wcl)              # 完全一致のみ(部分一致は誤爆するため不使用)
        if sc > bs:
            bs, best = sc, (la, lo)
    return best  # 路線canon完全一致≥1のみ更新


updated = filled = 0
for st in S:
    bw = best_wd(st)
    if not bw:
        continue
    la, lo = bw
    if st.get('la') is None:
        st['la'], st['lo'] = la, lo
        filled += 1
    elif hav(st['la'], st['lo'], la, lo) > 2.0:
        st['la'], st['lo'] = la, lo
        updated += 1

json.dump(G, open('graph_v2.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print(f'updated(>2km): {updated}, filled missing: {filled}')

# 残存する同一座標衝突を報告(異名/別県の同名は要注意)
bycoord = defaultdict(list)
for i, s in enumerate(S):
    if s.get('la') is not None:
        bycoord[(round(s['la'], 4), round(s['lo'], 4))].append(s['n'])
bad = []
for names in bycoord.values():
    base = {basename(n) for n in names}
    if len(set(names)) > 1 and len(base) > 1:
        bad.append(names)  # 異名が同一座標 = 近接の可能性もあるが汚染候補
print(f'残: 異名が同一座標のグループ {len(bad)}')
for b in bad[:20]:
    print('  ', b)
