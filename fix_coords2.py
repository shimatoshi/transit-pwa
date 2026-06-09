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


# 47都道府県のおおよその重心(同名別都市駅を地理で曖昧解消するため)
PREF_C = {
    '北海道': (43.2, 142.4), '青森': (40.8, 140.7), '岩手': (39.6, 141.3), '宮城': (38.4, 140.9),
    '秋田': (39.7, 140.4), '山形': (38.4, 140.2), '福島': (37.4, 140.3), '茨城': (36.3, 140.3),
    '栃木': (36.6, 139.9), '群馬': (36.5, 139.0), '埼玉': (35.9, 139.4), '千葉': (35.5, 140.2),
    '東京': (35.69, 139.70), '神奈川': (35.44, 139.58), '新潟': (37.5, 138.9), '富山': (36.7, 137.2),
    '石川': (36.7, 136.7), '福井': (35.8, 136.2), '山梨': (35.6, 138.6), '長野': (36.2, 138.0),
    '岐阜': (35.8, 137.0), '静岡': (34.9, 138.4), '愛知': (35.0, 137.1), '三重': (34.5, 136.4),
    '滋賀': (35.2, 136.1), '京都': (35.2, 135.5), '大阪': (34.6, 135.5), '兵庫': (34.9, 134.9),
    '奈良': (34.3, 135.8), '和歌山': (33.9, 135.3), '鳥取': (35.4, 133.8), '島根': (35.1, 132.6),
    '岡山': (34.9, 133.8), '広島': (34.5, 132.8), '山口': (34.2, 131.5), '徳島': (33.9, 134.4),
    '香川': (34.3, 134.0), '愛媛': (33.6, 132.9), '高知': (33.5, 133.4), '福岡': (33.6, 130.5),
    '佐賀': (33.3, 130.1), '長崎': (33.0, 129.9), '熊本': (32.6, 130.7), '大分': (33.2, 131.4),
    '宮崎': (32.0, 131.3), '鹿児島': (31.6, 130.6), '沖縄': (26.3, 127.8),
}


def suffix_centroid(name):
    # 駅名の(地名)サフィックスで都道府県重心を引く。pフィールドは元バグで
    # 座標と一緒に汚染されている(中島(愛知)のp=広島県)ため、名前の括弧内を使う。
    m = re.search(r'[（(](.+?)[)）]', name)
    if not m:
        return None
    s = m.group(1)
    if s == '北海道':
        return PREF_C['北海道']
    for key, c in PREF_C.items():       # 「愛知」「神奈川」等の前方一致
        if s.startswith(key):
            return c
    return None


widx = defaultdict(list)
for v in W.values():
    bn = basename(v['name'])
    cl = {canon_line(l) for l in (v.get('lines') or [])}
    widx[bn].append((v['lat'], v['lon'], cl, v['name']))


def best_wd(st):
    cands = widx.get(basename(st['n']))
    if not cands:
        return None
    # 1) 同名複数 + 名前のサフィックスが都道府県なら、その重心に最も近い候補を採用
    c = suffix_centroid(st['n'])
    if len(cands) > 1 and c:
        best, bd = None, 1e9
        for la, lo, wcl, wn in cands:
            d = hav(la, lo, c[0], c[1])
            if d < bd:
                bd, best = d, (la, lo)
        if bd < 120:        # 県重心から120km以内の候補が見つかれば確定
            return best
    # 2) それ以外は路線canon完全一致(部分一致は誤爆するため不使用)
    cl = {canon_line(l) for l in (st.get('l') or [])}
    cl.discard('')
    best, bs = None, 0
    for la, lo, wcl, wn in cands:
        sc = len(cl & wcl)
        if sc > bs:
            bs, best = sc, (la, lo)
    return best


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
