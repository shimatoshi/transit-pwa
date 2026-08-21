#!/usr/bin/env python3
"""fix_coords4.py — 同名の別駅の座標が入り込んでいる駅を直し、徒歩連絡を張り直す。

fix_coords.py / fix_coords2.py は駅名一致だけで wikidata の座標を取り込んでいた
(地理ゲートは fix_coords3.py で後から足したもので、既に入っていた座標は見直して
いない)。その結果、同名駅が複数ある駅で数十km離れた別駅の座標が残っている。

これは座標の誤りだけでは済まない。make_trains_v3.build_footpaths() は座標の
近さで徒歩連絡を張るので、誤座標どうしが近接すると **数十kmを数分で移動できる
連絡** ができ、探索がそれを最短経路として使う:

    三宮 → 関西空港 (修正前 1位)
      阪神本線[普通]     魚崎 09:21 → 住吉(阪神) 09:23      ← 神戸市東灘区
      阪堺電軌阪堺線[普通] 住吉(大阪) 09:33 → 住吉鳥居前 09:34  ← 大阪市住吉区(約24km先)

    住吉(阪神) ⇄ 住吉(大阪) が「徒歩3分」で繋がっていた。

対象は node qa_coords_adj.js で「最寄りの隣接駅から15km超」に出た駅のうち、
新幹線単独駅・北海道の閑散区間(正当に隣が遠い)を除いた5駅。
座標は wikidata_stations.json 内の**路線名が一致する**同名駅から取る
(名鉄豊川線の八幡だけ wikidata に無いので実測値を直接置く)。

適用後、meta.footpaths を build_footpaths() で全面的に張り直す。
footpaths は trains_v3_meta.json 側にしか無いので trains_v3.bin は再生成不要。

Usage: python3 fix_coords4.py [--dry-run]
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from make_trains_v3 import build_footpaths, haversine_km  # noqa: E402

DRY = '--dry-run' in sys.argv

# 駅名 -> (正しい緯度, 経度, 典拠)
# 「最寄りの隣接駅までの距離」が妥当になることを適用前に検証する(下の MAX_NEAR_KM)。
FIXES = {
    '立花': (34.72556, 135.41083,
             'JR東海道本線 尼崎市立花町。wikidataの立花駅は元町(ＪＲ)の座標(34.6896,135.187)が'
             '入っており典拠にできないため実測値。隣接の尼崎(ＪＲ)/甲子園口と整合する'),
    '住吉(大阪)': (34.6144, 135.492,
                   'wikidata 住吉停留場 (上町線,阪堺線)。従来は阪神本線の住吉駅(神戸市東灘区)の座標'),
    '土橋(広島)': (34.394444, 132.446389,
                   'wikidata 土橋停留場 (広島電鉄江波線,広島電鉄本線)。従来は伊予鉄道郡中線の土橋駅(松山市)'),
    '新田(宮城)': (38.71138889, 141.11972222,
                   'wikidata 新田駅 (東北本線)。従来は仙石線の新田駅(仙台市)'),
    '八幡(愛知)': (34.8290, 137.3524,
                   '名鉄豊川線 豊川市八幡町。wikidataには遠州鉄道と鹿児島本線の八幡駅しか無く'
                   '従来は遠州鉄道(浜松市)の座標。隣接の国府(愛知)/諏訪町の間に収まる'),
}

MAX_NEAR_KM = 8.0   # 修正後、最寄りの隣接駅までがこれを超えたら座標が疑わしいので中止

gp = os.path.join(BASE, 'graph_v2.json')
mp = os.path.join(BASE, 'trains_v3_meta.json')
graph = json.load(open(gp))
meta = json.load(open(mp))
stations = graph['stations']

# 隣接リスト(graph_v2.edges は {駅index: [[相手, 重み, 路線], ...]})
adj = {}
for k, lst in graph['edges'].items():
    i = int(k)
    for e in lst:
        j = e[0]
        adj.setdefault(i, set()).add(j)
        adj.setdefault(j, set()).add(i)

# 対象は鉄道駅のみ。バス停(m=1)には「立花」「新田」のような同名の停留所が
# いくらでもあり、それらまで数えると「該当3件」で中止してしまう。
byname = {}
for i, s in enumerate(stations):
    if s.get('m'):
        continue
    byname.setdefault(s['n'], []).append(i)

changed = []
for name, (la, lo, why) in FIXES.items():
    ids = byname.get(name, [])
    if len(ids) != 1:
        print(f'!! {name}: 該当 {len(ids)}件。手当てを見直すこと')
        sys.exit(1)
    i = ids[0]
    s = stations[i]
    old = (s['la'], s['lo'])
    near = min((haversine_km(la, lo, stations[j]['la'], stations[j]['lo'])
                for j in adj.get(i, ()) if stations[j].get('la') is not None), default=None)
    oldnear = min((haversine_km(old[0], old[1], stations[j]['la'], stations[j]['lo'])
                   for j in adj.get(i, ()) if stations[j].get('la') is not None), default=None)
    if near is None or near > MAX_NEAR_KM:
        print(f'!! {name}: 修正後も最寄り隣接が {near}km。中止')
        sys.exit(1)
    print(f'{name}: ({old[0]},{old[1]}) → ({la},{lo})')
    print(f'    最寄り隣接まで {oldnear:.1f}km → {near:.2f}km')
    print(f'    典拠: {why}')
    s['la'], s['lo'] = la, lo
    changed.append(name)

# --- 徒歩連絡の張り直し ---
old_fp = meta.get('footpaths', [])
new_fp = build_footpaths(stations)
old_set = {(a, b) for a, b, _ in old_fp}
new_set = {(a, b) for a, b, _ in new_fp}
removed = sorted(old_set - new_set)
added = sorted(new_set - old_set)
nm = lambda i: stations[i]['n']
print(f'\n徒歩連絡: {len(old_fp)} → {len(new_fp)} (削除 {len(removed)} / 追加 {len(added)})')
print('  --- 削除(誤座標が作っていたワームホール) ---')
for a, b in removed:
    print(f'    {nm(a)} ⇄ {nm(b)}')
print('  --- 追加(正しい座標で初めて成立する連絡) ---')
for a, b in added:
    w = next(w for x, y, w in new_fp if (x, y) == (a, b))
    print(f'    {nm(a)} ⇄ {nm(b)} {w}分')

meta['footpaths'] = new_fp

if DRY:
    print('\n--dry-run: 書き込みなし')
else:
    json.dump(graph, open(gp, 'w'), ensure_ascii=False, separators=(',', ':'))
    json.dump(meta, open(mp, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(f'\n書き込み: {gp}\n         {mp}')
