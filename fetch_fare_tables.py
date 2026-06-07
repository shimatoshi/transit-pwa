#!/usr/bin/env python3
"""時刻表の達人(jikokuhyo.train-times.net)の運賃変遷ページから
各社の最新運賃表(距離帯→IC運賃)を抽出して fare_tables_raw.json に保存する。

ページ構造: 「改定日/営業キロ」ヘッダの履歴テーブルがあり、列=改定日。
今日以前で最新の改定列を採用する。
"""
import json
import re
import html
import subprocess
import sys
from datetime import date

TODAY = date(2026, 6, 7)
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0"

SLUGS = [
    # 関東
    'tobu', 'keisei', 'keio', 'odakyu', 'tokyu', 'seibu', 'keikyu', 'sotetsu',
    'tokyometro', 'toeisubway', 'yurikamome', 'rinkai', 'toyo', 'saitama',
    'yokohamasubway', 'tx', 'hokuso', 'minatomirai', 'tokyomonorail',
    # JR
    'jreast', 'jrkyushu', 'jrhokkaido', 'jrshikoku', 'jrwest', 'jrtokai',
    # 中部・関西・九州
    'meitetsu', 'kintetsu', 'nankai', 'keihan', 'hankyu', 'hanshin',
    'nishitetsu', 'kobe', 'nagoya', 'osaka',
]


def fetch(slug):
    for path in (f'data/{slug}_fare', f'news/{slug}_fare'):
        url = f'https://jikokuhyo.train-times.net/{path}'
        r = subprocess.run(['curl', '-s', '-o', '-', '-w', '\n%{http_code}',
                            '-A', UA, url], capture_output=True, text=True)
        body, _, code = r.stdout.rpartition('\n')
        if code.strip() == '200' and '<table' in body:
            return body, url
    return None, None


def parse_tables(src):
    out = []
    for t in re.findall(r'<table.*?</table>', src, re.S):
        rows = []
        for r in re.findall(r'<tr.*?</tr>', t, re.S):
            cells = [html.unescape(re.sub(r'<[^>]+>', '', c)).strip()
                     for c in re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', r, re.S)]
            if cells:
                rows.append(cells)
        if rows:
            out.append(rows)
    return out


def parse_date(s):
    m = re.search(r'(\d{4})/(\d{1,2})/(\d{1,2})', s)
    return date(*map(int, m.groups())) if m else None


def yen(s):
    s = s.replace(',', '').replace('円', '').strip()
    return int(s) if s.isdigit() else None


def km_upper(s):
    # '1～3' -> 3, '58～59' -> 59, '40' -> 40
    nums = re.findall(r'\d+', s)
    return int(nums[-1]) if nums else None


def extract_latest(rows):
    """履歴テーブル(ヘッダに改定日列)から最新有効列を選ぶ"""
    header = rows[0]
    dated = [(i, parse_date(c)) for i, c in enumerate(header)]
    dated = [(i, d) for i, d in dated if d and d <= TODAY]
    if not dated:
        return None, None
    col, eff = max(dated, key=lambda x: x[1])
    table = []
    for r in rows[1:]:
        if len(r) <= col:
            continue
        km = km_upper(r[0])
        v = yen(r[col])
        if km is not None and v is not None:
            table.append([km, v])
    return table, eff.isoformat()


def main():
    result = {}
    for slug in SLUGS:
        src, url = fetch(slug)
        if not src:
            print(f'NG  {slug}: page not found', file=sys.stderr)
            continue
        best, best_eff = None, None
        for rows in parse_tables(src):
            if len(rows) < 3:
                continue
            tbl, eff = extract_latest(rows)
            # 距離帯が単調増加かつ3行以上のものだけ
            if tbl and len(tbl) >= 3 and all(tbl[i][0] < tbl[i+1][0] for i in range(len(tbl)-1)):
                # 最新の改定日のテーブルを優先、同日なら帯数が多い方
                key = (eff, len(tbl))
                if best is None or key > (best_eff, len(best)):
                    best, best_eff = tbl, eff
        if best:
            result[slug] = {'effective': best_eff, 'ic_fare': best, 'src': url}
            print(f'OK  {slug}: {len(best)} bands, effective {best_eff}, '
                  f'first={best[0]}, last={best[-1]}')
        else:
            print(f'NG  {slug}: no usable table', file=sys.stderr)
    with open('fare_tables_raw.json', 'w') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f'\nsaved {len(result)} companies -> fare_tables_raw.json')


if __name__ == '__main__':
    main()
