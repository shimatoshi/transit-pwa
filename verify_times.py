#!/usr/bin/env python3
"""verify_times.py — 「乗るべき電車の時刻」を分単位で Yahoo と突合。
総所要時間ではなく、各レグの発車時刻・路線・行先が一致するかを見る。
ルート形状(路線の並び)が一致する試行のみ、全レグの発着時刻を厳密照合。"""
import re, html, json, subprocess, urllib.parse, urllib.request, time

UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'

ROUTES = [
    ('柏', '東京'), ('新宿', '東京'), ('池袋', '所沢'), ('渋谷', '横浜'),
    ('品川', '横浜'), ('北千住', '南流山'), ('大宮(埼玉)', '赤羽'),
    ('東京', '新大阪'), ('名古屋', '京都'), ('天神', '博多'),
    ('横浜', '鎌倉'), ('上野', '高崎'),
]
TIMES = [8, 17]


def hhmm(m):
    return f'{(m // 60) % 24:02d}:{m % 60:02d}'


def yahoo_legs(frm, to, hh):
    q = urllib.parse.urlencode({
        'from': frm, 'to': to, 'y': 2026, 'm': '06', 'd': '09', 'hh': hh, 'm1': 0, 'm2': 0,
        'type': 1, 's': 0, 'shin': 1, 'exp': 1, 'ws': 3, 'ticket': 'ic',
    })
    req = urllib.request.Request('https://transit.yahoo.co.jp/search/result?' + q,
                                 headers={'User-Agent': UA})
    raw = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')
    m = re.search(r'class="routeDetail".*?(?=class="(?:routeSummary|elmRouteResearch))', raw, re.S)
    if not m:
        return None
    t = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', m.group(0))))
    # 乗車レグ: 発時刻/駅/路線/行先 と、その直後に来る到着時刻
    legs = []
    for mm in re.finditer(r'(\d\d:\d\d)\s*発\s*(\S+?)\s*時刻表\s*地図\s*(\S+?)\s*(\S+?)行(.*?)(\d\d:\d\d)\s*着\s*(\S+)', t):
        legs.append({'fromT': mm.group(1), 'from': mm.group(2), 'line': mm.group(3),
                     'dest': mm.group(4), 'toT': mm.group(6), 'to': mm.group(7)})
    return legs


def mine(frm, to, hh):
    r = subprocess.run(['node', 'oneroute.js', frm, to, str(hh)], capture_output=True, text=True)
    return json.loads(r.stdout.strip())


def linekey(s):
    return s.replace('ＪＲ', '').replace('JR', '').replace(' ', '')


tot = same_shape = leg_exact = leg_total = first_exact = first_total = 0
for frm, to in ROUTES:
    for hh in TIMES:
        try:
            yl = yahoo_legs(re.sub(r'[（(].*?[）)]', '', frm), re.sub(r'[（(].*?[）)]', '', to), hh)
        except Exception:
            yl = None
        mr = mine(frm, to, hh)
        if mr.get('error') or not yl:
            print(f'{frm}→{to} {hh}時: 取得失敗(自作:{mr.get("error","")} Yahoo:{"無" if not yl else "有"})')
            continue
        ml = mr['legs']
        tot += 1
        # ルート形状一致判定: 路線(canon)の並びが一致
        mshape = [linekey(l['line']) for l in ml]
        yshape = [linekey(l['line']) for l in yl]

        def loose_eq(a, b):
            return a == b or a in b or b in a
        shape_match = len(mshape) == len(yshape) and all(loose_eq(a, b) for a, b in zip(mshape, yshape))
        # 最初の乗車電車の時刻一致(最重要)
        first_total += 1
        f_ok = (hhmm(ml[0]['fromT']) == yl[0]['fromT'] and loose_eq(linekey(ml[0]['line']), linekey(yl[0]['line'])))
        if f_ok:
            first_exact += 1
        if shape_match:
            same_shape += 1
            allok = True
            for a, b in zip(ml, yl):
                leg_total += 1
                ok = hhmm(a['fromT']) == b['fromT'] and hhmm(a['toT']) == b['toT']
                if ok:
                    leg_exact += 1
                else:
                    allok = False
            tag = '✓全レグ時刻一致' if allok else '✗時刻ズレ'
            print(f'{frm}→{to} {hh}時 [{tag}] 自作:' +
                  ' / '.join(f'{l["from"]}{hhmm(l["fromT"])}→{l["to"]}{hhmm(l["toT"])}{l["line"]}' for l in ml))
            if not allok:
                print('      Yahoo:' + ' / '.join(f'{l["from"]}{l["fromT"]}→{l["to"]}{l["toT"]}{l["line"]}' for l in yl))
        else:
            mark = '(初電一致)' if f_ok else '(初電も相違)'
            print(f'{frm}→{to} {hh}時 [別ルート形状]{mark} 自作{mshape} vs Yahoo{yshape}')
            print(f'      自作初電 {ml[0]["from"]}{hhmm(ml[0]["fromT"])}発 {ml[0]["line"]} / Yahoo初電 {yl[0]["from"]}{yl[0]["fromT"]}発 {yl[0]["line"]}')
        time.sleep(0.8)

print('-' * 80)
print(f'試行{tot}: 形状一致{same_shape} / 全レグ時刻[{leg_exact}/{leg_total}一致] / 最初の電車の発時刻[{first_exact}/{first_total}一致]')
