#!/usr/bin/env python3
"""compare_yahoo.py — 自作エンジン vs Yahoo!乗換案内 の比較。
Yahoo結果はHTTP取得(shin=1新幹線/exp=1有料特急/s=0時間順)。最速便を突合。"""
import re, html, json, subprocess, urllib.parse, urllib.request, sys, time

UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'

# (from, to) — 全国・運賃種別を散らす。同名は(地名)付き
ROUTES = [
    ('東京', '新大阪'), ('東京', '仙台'), ('東京', '金沢'), ('博多', '鹿児島中央'),
    ('名古屋', '大阪難波'), ('大阪', '京都'), ('三ノ宮', '姫路'), ('新宿', '松本'),
    ('柏', '東京'), ('渋谷', '横浜'), ('品川', '羽田空港第１・第２ターミナル'),
    ('高松(香川)', '松山(愛媛)'), ('岡山', '出雲市'), ('和歌山', '新宮'), ('宮崎', '鹿児島中央'),
    ('池袋', '所沢'), ('北千住', 'つくば'), ('日暮里', '成田空港'),
]


def yahoo(frm, to, hh=9):
    strip = lambda n: re.sub(r'[（(].*?[）)]', '', n)        # Yahooは素の駅名で
    q = urllib.parse.urlencode({
        'from': strip(frm), 'to': strip(to), 'y': 2026, 'm': '06', 'd': '09',
        'hh': hh, 'm1': 0, 'm2': 0, 'type': 1, 's': 0,
        'shin': 1, 'exp': 1, 'ws': 3, 'ticket': 'ic',
    })
    url = 'https://transit.yahoo.co.jp/search/result?' + q
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    raw = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')
    t = html.unescape(re.sub(r'<[^>]+>', ' ', raw))
    t = re.sub(r'\s+', ' ', t)
    best = None
    for m in re.finditer(r'(\d{1,2}):(\d{2})\s*→\s*(\d{1,2}):(\d{2})\s*（\s*(?:(\d+)時間)?(?:(\d+)分)?\s*）'
                         r'.{0,30}?([\d,]+)\s*円\s*乗換:\s*(\d+)\s*回', t):
        dh, dm, ah, am, H, M, fare, tr = m.groups()
        dur = (int(H or 0) * 60 + int(M or 0))
        cand = {'dep': int(dh) * 60 + int(dm), 'arr': int(ah) * 60 + int(am),
                'min': dur, 'fare': int(fare.replace(',', '')), 'transfers': int(tr)}
        if best is None or cand['arr'] < best['arr']:
            best = cand
    return best


def mine(frm, to, hh=9):
    r = subprocess.run(['node', 'oneroute.js', frm, to, str(hh)], capture_output=True, text=True)
    return json.loads(r.stdout.strip())


def fmt(m):
    return f'{(m//60)%24:02d}:{m%60:02d}' if m is not None else '--'


print(f'{"区間":<22}{"自作 時間/乗換/¥":<26}{"Yahoo 時間/乗換/¥":<26}差')
print('-' * 86)
for frm, to in ROUTES:
    try:
        y = yahoo(frm, to)
    except Exception as e:
        y = None
    mr = mine(frm, to)
    label = f'{frm}→{to}'
    if mr.get('error'):
        print(f'{label:<22}{"自作:"+mr["error"]:<26}')
        continue
    ms = f'{mr["min"]}分/{mr["transfers"]}/{mr["fare"]}'
    if not y:
        print(f'{label:<22}{ms:<26}{"Yahoo取得失敗":<26}')
        continue
    ys = f'{y["min"]}分/{y["transfers"]}/{y["fare"]}'
    dmin = mr['min'] - y['min']
    dfare = mr['fare'] - y['fare']
    print(f'{label:<22}{ms:<26}{ys:<26}時間{dmin:+d} 運賃{dfare:+d}')
    time.sleep(1.2)
