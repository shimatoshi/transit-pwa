#!/usr/bin/env python3
"""Build a bounded collection plan from saved audits and the current catalog."""
import argparse
import json
from pathlib import Path
import re
from datetime import datetime, timezone
import unicodedata

p = argparse.ArgumentParser()
p.add_argument('--audit-root', required=True, type=Path)
p.add_argument('--output', required=True, type=Path)
a = p.parse_args()
base = a.audit_root
load = lambda name: json.loads((base / name).read_text())
graph = load('transit-pwa-master/graph_v2.json')['stations']
audit = load('collection-20261008/audit.json')
ids = {x['ekitan_id'] for x in audit['thin_candidates'] if x.get('ekitan_id')}
gap_names = {n for x in audit['direction_gap_candidates'] if not x['allowed'] for n in (x['from'], x['to'])}
ids.update(s['k'] for s in graph if s.get('k') and s['n'] in gap_names and s.get('m', 0) != 1)
ids.update(load('collection-20261008/station_inventory.json')['not_in_graph'])
names = {s['k']: s['n'] for s in graph if s.get('k') and s.get('m', 0) != 1}
stations = [{'station_id': sid, 'name': names.get(sid),
             'url': 'https://ekitan.com/timetable/railway/station/' + sid,
             'reason': 'thin/direction/inventory candidate; operating status unverified'} for sid in sorted(ids)]
today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
feeds = []
for x in load('gtfs-catalog-current.json')['body']:
    if not re.search('鉄道|電車|市電|Streetcar|DMV', x['feed_name'], re.I) or 'バス' in x['feed_name']:
        continue
    if x.get('file_from_date', '') > today or x.get('file_to_date', '9999-12-31') < today:
        continue
    key = re.sub('[^a-z0-9]+', '_', (x['organization_id'] + '_' + x['feed_id']).lower())
    feeds.append({'key': key, 'url': x['file_url'], 'name': x['feed_name'],
                  'operator': x['organization_name'], 'catalog': x['feed_page_url'],
                  'license': x.get('feed_license_id'), 'license_url': x.get('feed_license_url'),
                  'from_date': x.get('file_from_date'), 'to_date': x.get('file_to_date'),
                  'attribution': x['organization_name'] + '・GTFSデータリポジトリ'})
feeds.extend([
    {'key': 'toei_train', 'name': '都営地下鉄・都電・日暮里舎人ライナー',
     'url': 'https://api-public.odpt.org/api/v4/files/Toei/data/Toei-Train-GTFS.zip',
     'catalog': 'https://ckan.odpt.org/dataset/train-toei', 'license': 'CC BY 4.0',
     'license_url': 'https://creativecommons.org/licenses/by/4.0/',
     'attribution': '東京都交通局・公共交通オープンデータ協議会'},
    {'key': 'hakodate_tram', 'name': '函館市電',
     'url': 'https://api-public.odpt.org/api/v4/files/odpt/HakodateCity/Alllines.zip?date=20260815',
     'catalog': 'https://ckan.odpt.org/dataset/hakodate_city_alllines', 'license': 'GTFS-RU',
     'license_url': 'https://gtfs-jp.org/', 'attribution': '函館市企業局・公共交通オープンデータ協議会',
     'distribution_review_required': True},
])
priority = []
for row in load('collection-20261008/timetables.json'):
    priority.append({'url': row['source_url'], 'day': row['dw'], 'name': row['station'],
                     'direction': row['direction'], 'reason': 'confirmed stale/direction/calendar candidate'})
def norm(s):
    return re.sub(r'\([^)]*\)|[\s・]', '', unicodedata.normalize('NFKC', s)).replace('ヶ', 'ケ').removesuffix('駅')
candidates = []
for x in load('station-database/comparison.json')['unmatched_candidates']:
    candidates.append({'key': 'stationdb:' + str(x['code']), 'name': x['name'],
                       'lat': x['lat'], 'lon': x['lng'], 'lines': x['lines'], 'sources': ['station_database']})
for x in load('mlit-2025/comparison.json')['unmatched_candidates']:
    hits = [y for y in candidates if norm(y['name']) == norm(x['station'])
            and abs(y['lat'] - x['lat']) < 0.003 and abs(y['lon'] - x['lon']) < 0.004]
    if hits:
        for y in hits:
            y['sources'].append('MLIT N02 2025')
    else:
        candidates.append({'key': 'mlit:' + x['group_code'], 'name': x['station'],
                           'lat': x['lat'], 'lon': x['lon'], 'lines': x['lines'], 'sources': ['MLIT N02 2025']})
official = [
    {'name': '札幌市電', 'url': 'https://www.stsp.or.jp/business/streetcar/time/'},
    {'name': '伊予鉄', 'url': 'https://www.iyotetsu.co.jp/railbus/timetable/'},
    {'name': '岡山電気軌道', 'url': 'https://okayama-kido.co.jp/tram/route-map/'},
    {'name': '鹿児島市電', 'url': 'https://www.kotsu-city-kagoshima.jp/wp/timesearch/mobile/rosen_list_mobile.php?syubetuId=1'},
    {'name': '長崎電気軌道', 'url': 'https://www.naga-den.com/'},
]
config = {'created_at': datetime.now(timezone.utc).isoformat(), 'feeds': feeds, 'stations': stations,
          'priority_timetables': priority, 'candidates': candidates, 'official_sources': official,
          'notes': ['Candidate lists are not confirmed missing stations.',
                    'Raw HTML/PDF collection does not imply parsed timetable completeness.',
                    'No production data mutation. Source licenses are recorded separately.']}
a.output.parent.mkdir(parents=True, exist_ok=True)
a.output.write_text(json.dumps(config, ensure_ascii=False, indent=2))
print(json.dumps({k: len(config[k]) for k in ['feeds', 'stations', 'priority_timetables', 'candidates', 'official_sources']}, ensure_ascii=False))
