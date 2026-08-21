#!/usr/bin/env python3
"""日本の鉄道駅のかな表記(P1814)と英語ラベルを Wikidata から一括取得する。

Issue #12: graph_v2.json の e(英字名)は Wikidata 英語ラベル依存で2,464件欠落、
かなは皆無。ここで取ったデータを patch_station_readings.py が graph_v2 に流し込む。

出力: wikidata_readings.json
  { "QID": {"ja": "北見駅", "kana": "きたみえき", "en": "Kitami Station",
            "la": 43.9, "lo": 143.88}, ... }
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

# 本家WDQSは障害時レート制限(1req/分)が掛かることがあるので、既定はQLeverミラー。
ENDPOINT = 'https://qlever.dev/api/wikidata'
BASE = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.join(BASE, 'wikidata_readings.json')

QUERY = """
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?station ?ja ?kana ?en ?coord WHERE {
  ?station wdt:P17 wd:Q17 .
  ?station wdt:P31/wdt:P279* wd:Q548662 .
  ?station rdfs:label ?ja . FILTER(LANG(?ja) = "ja")
  OPTIONAL { ?station wdt:P1814 ?kana }
  OPTIONAL { ?station rdfs:label ?en . FILTER(LANG(?en) = "en") }
  OPTIONAL { ?station wdt:P625 ?coord }
}
ORDER BY ?station
"""


def sparql(query, retries=3):
    req = urllib.request.Request(
        ENDPOINT, data=query.encode('utf-8'),
        headers={'User-Agent': 'TransitPWA/1.0 (offline route planner)',
                 'Content-Type': 'application/sparql-query',
                 'Accept': 'application/sparql-results+json'})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            print(f'  attempt {attempt + 1} failed: {e}', file=sys.stderr)
            if attempt < retries - 1:
                time.sleep(10 * (attempt + 1))
    return None


def parse_coord(s):
    # WDQSは "Point(...)"、QLeverは "POINT(...)" を返す
    s = re.sub(r'(?i)^point\(', '', s.strip()).replace(')', '')
    parts = s.replace(',', ' ').split()
    if len(parts) < 2:
        return None, None
    return float(parts[1]), float(parts[0])


def main():
    stations = {}
    limit, offset = 10000, 0
    while True:
        print(f'fetching offset={offset} ...')
        data = sparql(QUERY + f'\nLIMIT {limit} OFFSET {offset}')
        if not data:
            raise SystemExit(f'fetch failed at offset {offset}')
        rows = data['results']['bindings']
        for r in rows:
            qid = r['station']['value'].split('/')[-1]
            rec = stations.setdefault(qid, {'ja': r['ja']['value']})
            if 'kana' in r and not rec.get('kana'):
                rec['kana'] = r['kana']['value']
            if 'en' in r and not rec.get('en'):
                rec['en'] = r['en']['value']
            if 'coord' in r and rec.get('la') is None:
                la, lo = parse_coord(r['coord']['value'])
                rec['la'], rec['lo'] = la, lo
        print(f'  got {len(rows)} rows (stations: {len(stations)})')
        if len(rows) < limit:
            break
        offset += limit
        time.sleep(2)

    n_kana = sum(1 for s in stations.values() if s.get('kana'))
    n_en = sum(1 for s in stations.values() if s.get('en'))
    print(f'stations: {len(stations)}, kana: {n_kana}, en: {n_en}')
    with open(OUTPUT, 'w') as f:
        json.dump(stations, f, ensure_ascii=False, separators=(',', ':'))
    print(f'saved {OUTPUT}')


if __name__ == '__main__':
    main()
