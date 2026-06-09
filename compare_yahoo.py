#!/usr/bin/env python3
"""compare_yahoo.py — 自作エンジン vs Yahoo!乗換案内 の大規模差分テスト。
多数OD × 複数時刻帯で、所要時間/乗換/運賃を突合。Yahooは routeSummary ブロック
単位で確実にパース(s=0=時間順の先頭=最速便)。新幹線/在来特急を有効化(shin=1,exp=1)。"""
import re, html, json, subprocess, urllib.parse, urllib.request, time, sys

UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'

# 路線/地域/種別/同名を散らした24区間
ROUTES = [
    # 通勤・近郊
    ('新宿', '東京'), ('渋谷', '横浜'), ('池袋', '所沢'), ('北千住', 'つくば'),
    ('柏', '東京'), ('横浜', '大宮(埼玉)'), ('品川', '羽田空港第１・第２ターミナル'),
    # 地下鉄・乗継割引
    ('押上', '六本木'), ('天神', '博多'),
    # 私鉄
    ('なんば', '関西空港'), ('京都', '大阪梅田'), ('名鉄名古屋', '豊橋'),
    ('西鉄福岡', '大牟田'), ('新宿', '小田原'),
    # 新幹線・長距離
    ('東京', '新大阪'), ('東京', '仙台'), ('博多', '鹿児島中央'), ('東京', '金沢'),
    # 在来線有料特急
    ('新宿', '甲府'), ('大阪', '金沢'), ('岡山', '出雲市'), ('高松(香川)', '松山(愛媛)'),
    # ローカル・地方
    ('青森', '秋田'), ('大分', '宮崎'),
]
TIMES = [8, 13, 23]   # 朝ラッシュ / 昼 / 深夜


def yahoo(frm, to, hh):
    strip = lambda n: re.sub(r'[（(].*?[）)]', '', n)
    q = urllib.parse.urlencode({
        'from': strip(frm), 'to': strip(to), 'y': 2026, 'm': '06', 'd': '09',
        'hh': hh, 'm1': 0, 'm2': 0, 'type': 1, 's': 0, 'shin': 1, 'exp': 1, 'ws': 3, 'ticket': 'ic',
    })
    req = urllib.request.Request('https://transit.yahoo.co.jp/search/result?' + q,
                                 headers={'User-Agent': UA})
    raw = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')
    blocks = re.split(r'class="routeSummary"', raw)[1:]
    if not blocks:
        return None
    t = html.unescape(re.sub(r'<[^>]+>', ' ', blocks[0][:1600]))
    t = re.sub(r'\s+', ' ', t)
    dep = re.search(r'(\d{1,2}):(\d{2})\s*→', t)
    arr = re.search(r'→\s*(\d{1,2}):(\d{2})', t)
    dur = re.search(r'（\s*(?:(\d+)時間)?(?:(\d+)分)?', t)
    fa = re.search(r'([\d,]+)\s*円', t)
    tr = re.search(r'乗換[:：]?\s*(\d+)', t)
    km = re.search(r'([\d.]+)\s*km', t)
    if not (dep and dur and fa and tr):
        return None
    return {
        'dep': int(dep.group(1)) * 60 + int(dep.group(2)),
        'min': int(dur.group(1) or 0) * 60 + int(dur.group(2) or 0),
        'fare': int(fa.group(1).replace(',', '')),
        'transfers': int(tr.group(1)),
        'km': float(km.group(1)) if km else None,
    }


def mine(frm, to, hh):
    r = subprocess.run(['node', 'oneroute.js', frm, to, str(hh)], capture_output=True, text=True)
    try:
        return json.loads(r.stdout.strip())
    except Exception:
        return {'error': 'node失敗:' + r.stderr[:60]}


rows = []
fare_exact = fare_110 = fare_500 = fare_big = time_close = n = 0
print(f'{"区間":<20}{"時":<4}{"自作 分/換/¥":<20}{"Yahoo 分/換/¥":<20}{"Δ時間":<7}{"Δ運賃":<8}メモ')
print('-' * 100)
for frm, to in ROUTES:
    for hh in TIMES:
        mr = mine(frm, to, hh)
        try:
            yr = yahoo(frm, to, hh)
        except Exception as e:
            yr = None
        label = f'{frm}→{to}'
        if mr.get('error'):
            print(f'{label:<20}{hh:<4}自作:{mr["error"]}')
            continue
        ms = f'{mr["min"]}/{mr["transfers"]}/{mr["fare"]}'
        if not yr:
            print(f'{label:<20}{hh:<4}{ms:<20}{"Yahoo取得失敗":<20}')
            continue
        n += 1
        ys = f'{yr["min"]}/{yr["transfers"]}/{yr["fare"]}'
        dmin = mr['min'] - yr['min']
        dfare = mr['fare'] - yr['fare']
        memo = ''
        ad = abs(dfare)
        if ad == 0: fare_exact += 1
        elif ad <= 110: fare_110 += 1
        elif ad <= 500: fare_500 += 1
        else:
            fare_big += 1
            # 経路タイプの違いを推定
            myexp = mr.get('express', 0)
            if abs(dmin) > 20: memo = '経路型相違(時間差大)'
            elif myexp and dfare > 0: memo = '自作が特急/指定?'
        if abs(dmin) <= 10: time_close += 1
        print(f'{label:<20}{hh:<4}{ms:<20}{ys:<20}{dmin:+d}分   {dfare:+d}円  {memo}')
        time.sleep(0.8)

print('-' * 100)
print(f'試行 {n} 件: 運賃[完全一致 {fare_exact} / ±110 {fare_110} / ±500 {fare_500} / >500 {fare_big}]  '
      f'所要時間±10分 {time_close}')
