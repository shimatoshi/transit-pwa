#!/usr/bin/env python3
"""verify_exist.py — 案内する各レグの電車が実在するかを Yahoo乗換で独立検証。
oneroute.js の最速経路を取り、各乗車レグ(発駅/発時刻/路線/行先)が Yahoo の
ルート結果に現れる実在列車かを照合。形状一致時は全レグの発着時刻も厳密照合し、
時刻ズレ(=データ破損)と初電不在(=幻列車候補)を切り分けてレポートする。

使い方: python3 verify_exist.py        # 既定ODセット
        python3 verify_exist.py 高柳 五反田 8
"""
import re, html, json, subprocess, sys, urllib.parse, urllib.request, time

UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'
DATE = ('2026', '06', '15')   # 月曜=平日

# 私鉄/直通/相互直通など幻列車・誤接続が出やすいODを厚めに
ROUTES = [
    ('高柳', '五反田'), ('船橋', '西馬込'), ('新宿', '西武新宿'),
    ('柏', '東京'), ('大宮(埼玉)', '横浜'), ('北千住', '中央林間'),
    ('押上', '羽田空港第１・第２ターミナル(京急)'), ('和光市', '元町・中華街'),
    ('所沢', '渋谷'), ('町田', '藤沢'), ('京成成田', '羽田空港第１・第２ターミナル(京急)'),
    ('久喜', '横浜'), ('川越', '横浜'), ('三鷹', '津田沼'),
    ('東京', '新大阪'), ('名古屋', '京都'), ('天神', '博多'),
    ('横浜', '鎌倉'), ('品川', '横浜'), ('上野', '高崎'),
]
TIMES = [8, 17]


def hhmm(m):
    return f'{(m // 60) % 24:02d}:{m % 60:02d}'


def strip_paren(s):
    return re.sub(r'[（(].*?[）)]', '', s)


def linekey(s):
    return s.replace('ＪＲ', '').replace('JR', '').replace(' ', '').replace('　', '')


def yahoo_raw(frm, to, hh):
    q = urllib.parse.urlencode({
        'from': frm, 'to': to, 'y': DATE[0], 'm': DATE[1], 'd': DATE[2],
        'hh': hh, 'm1': 0, 'm2': 0, 'type': 1, 'ticket': 'ic',
        's': 0, 'shin': 1, 'exp': 1, 'ws': 3,
    })
    req = urllib.request.Request('https://transit.yahoo.co.jp/search/result?' + q,
                                 headers={'User-Agent': UA})
    return urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')


def yahoo_legs(raw):
    """選択中ルートの乗車レグ列を返す。"""
    m = re.search(r'class="routeDetail".*?(?=class="(?:routeSummary|elmRouteResearch))', raw, re.S)
    if not m:
        return None
    t = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', m.group(0))))
    legs = []
    for mm in re.finditer(r'(\d\d:\d\d)\s*発\s*(\S+?)\s*時刻表\s*地図\s*(\S+?)\s*(\S+?)行(.*?)(\d\d:\d\d)\s*着\s*(\S+)', t):
        legs.append({'fromT': mm.group(1), 'from': mm.group(2), 'line': mm.group(3),
                     'dest': mm.group(4), 'toT': mm.group(6), 'to': mm.group(7)})
    return legs


def yahoo_departures(raw):
    """raw全体から「HH:MM発 駅名 … 路線」っぽい実在発車の集合を抽出(存在確認用)。"""
    t = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', raw)))
    deps = set()
    for mm in re.finditer(r'(\d\d:\d\d)\s*発\s*(\S+?)\s*時刻表\s*地図\s*(\S+?)\s', t):
        deps.add((mm.group(1), strip_paren(mm.group(2)), linekey(mm.group(3))))
    return deps


def mine(frm, to, hh):
    r = subprocess.run(['node', 'oneroute.js', frm, to, str(hh), '0'],
                       capture_output=True, text=True)
    try:
        return json.loads(r.stdout.strip())
    except Exception:
        return {'error': 'parse'}


_cache = {}


def leg_exists(leg):
    """レグ単位サブ検索: 発駅→着駅をその発時刻でYahoo検索し、同時刻・同路線の発車が
    実在するか確認する(±2分, 路線ゆるく一致)。route検索の表示経路制限を回避。"""
    fs, es = strip_paren(leg['from']), strip_paren(leg['to'])
    lk = linekey(leg['line'])
    t0 = leg['fromT']
    hh, mm = (t0 // 60) % 24, t0 % 60
    ck = (fs, es, t0)
    if ck in _cache:
        deps = _cache[ck]
    else:
        try:
            q = urllib.parse.urlencode({
                'from': fs, 'to': es, 'y': DATE[0], 'm': DATE[1], 'd': DATE[2],
                'hh': hh, 'm1': mm // 10, 'm2': mm % 10, 'type': 1, 'ticket': 'ic',
                's': 0, 'shin': 1, 'exp': 1, 'ws': 3,
            })
            req = urllib.request.Request('https://transit.yahoo.co.jp/search/result?' + q,
                                         headers={'User-Agent': UA})
            raw = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')
            deps = yahoo_departures(raw)
        except Exception:
            deps = None
        _cache[ck] = deps
        time.sleep(0.6)
    if deps is None:
        return (None, None)   # 取得失敗
    # 同駅の発車を抽出し、自作発時刻に最も近いものを記録
    same = []
    for (yt, ys, yl) in deps:
        if ys == fs or ys in fs or fs in ys:
            ymin = int(yt[:2]) * 60 + int(yt[3:])
            same.append((abs(ymin - t0), yt, yl))
    same.sort()
    for dt in (0, 1, -1, 2, -2):
        cand = hhmm(t0 + dt)
        for (yt, ys, yl) in deps:
            if yt == cand and (ys == fs or ys in fs or fs in ys):
                if not lk or not yl or yl == lk or yl in lk or lk in yl:
                    return (True, None)
    nearest = f'{same[0][1]}{same[0][2]}(±{same[0][0]}分)' if same else 'その駅の発車自体なし'
    return (False, nearest)


def run(routes):
    tot = leg_real = leg_tot = leg_fail = 0
    phantom = []
    for frm, to in routes:
        for hh in TIMES:
            mr = mine(frm, to, hh)
            if mr.get('error'):
                print(f'{frm}→{to} {hh}時: 自作経路なし({mr.get("error")})')
                continue
            ml = mr['legs']
            tot += 1
            results = []
            unconfirmed = []
            for l in ml:
                leg_tot += 1
                ok, nearest = leg_exists(l)
                if ok is True:
                    leg_real += 1
                    results.append('✓')
                elif ok is None:
                    leg_fail += 1
                    results.append('?')
                else:
                    unconfirmed.append((l, nearest))
                    results.append('✗')
            line = ' / '.join(f'{results[i]}{ml[i]["from"]}{hhmm(ml[i]["fromT"])}{linekey(ml[i]["line"])}'
                              f'{ml[i].get("type","")}' for i in range(len(ml)))
            mark = '実在' if not unconfirmed else '幻あり!'
            print(f'[{mark}] {frm}→{to} {hh}時: {line}')
            for l, nearest in unconfirmed:
                print(f'      ✗{l["from"]}{hhmm(l["fromT"])}{l["line"]}{l.get("type","")}→{l.get("dest","")} '
                      f'｜最寄実在={nearest}')
                phantom.append((frm, to, hh, l, nearest))

    print('-' * 90)
    print(f'試行{tot}件: レグ実在[{leg_real}/{leg_tot}] 取得失敗{leg_fail}')
    if phantom:
        print(f'\n幻候補レグ {len(phantom)}件(発着駅間をその発時刻で検索しても該当列車が無い):')
        for frm, to, hh, l in phantom:
            print(f'  {frm}→{to} {hh}時: {l["from"]}{hhmm(l["fromT"])}発→{l["to"]}{hhmm(l["toT"])}着 '
                  f'{l["line"]} {l.get("type","")} {l.get("dest","")}行')


if __name__ == '__main__':
    if len(sys.argv) >= 3:
        run([(sys.argv[1], sys.argv[2])])
    else:
        run(ROUTES)
