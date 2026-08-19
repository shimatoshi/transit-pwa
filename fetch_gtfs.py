#!/usr/bin/env python3
"""
GTFS-JP フィードの取得。

PR1 では「再配布可能なライセンス(CC BY / CC0)で、かつ認証なしで取得できる」
フィードだけをホワイトリストで持つ。ODPT の「公共交通オープンデータ基本ライセンス」は
再配布制限があるためオフライン同梱に使えず、ここには載せない。

  python3 fetch_gtfs.py                 # ホワイトリスト全件
  python3 fetch_gtfs.py --only toei     # 都営バスのみ
  python3 fetch_gtfs.py --force         # sha256 が同じでも取り直す

出力:
  data/gtfs/{key}.zip
  data/gtfs/_manifest.json  … 出典表示(CC BY の表示義務)とビルド再現性のための台帳
"""

import argparse
import hashlib
import io
import json
import os
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))

# 再配布可(オフライン同梱可)なフィードのみ。追加時は license を必ず確認すること。
FEEDS = {
    'toei': {
        'name': '都営バス',
        'operator': '東京都交通局',
        'url': 'https://api-public.odpt.org/api/v4/files/Toei/data/ToeiBus-GTFS.zip',
        'catalog': 'https://ckan.odpt.org/ja/dataset/b_bus_gtfs_jp-toei',
        'license': 'CC BY 4.0',
        'license_url': 'https://creativecommons.org/licenses/by/4.0/deed.ja',
        # CC BY 4.0 の表示義務。index.html のクレジットはこの文字列を出典とする
        'attribution': '東京都交通局・公共交通オープンデータ協議会',
        'pref': '東京都',
    },
}

UA = 'transit-pwa gtfs fetcher (+https://github.com/shimatoshi/transit-pwa)'


def fetch(url, timeout=300):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def feed_info(zip_bytes):
    """feed_info.txt / agency.txt からデータ基準日と事業者名を拾う(台帳・UI表示用)"""
    out = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        names = set(z.namelist())
        if 'feed_info.txt' in names:
            import csv
            with z.open('feed_info.txt') as f:
                rows = list(csv.DictReader(io.TextIOWrapper(f, 'utf-8-sig')))
            if rows:
                r = rows[0]
                out['feed_version'] = r.get('feed_version', '')
                out['feed_start_date'] = r.get('feed_start_date', '')
                out['feed_end_date'] = r.get('feed_end_date', '')
                out['feed_publisher_name'] = r.get('feed_publisher_name', '')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(BASE, 'data', 'gtfs'))
    ap.add_argument('--only', action='append', help='フィードキー(複数可)')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    keys = args.only or list(FEEDS)
    unknown = [k for k in keys if k not in FEEDS]
    if unknown:
        sys.exit(f'unknown feed key(s): {unknown}. known: {list(FEEDS)}')

    os.makedirs(args.out, exist_ok=True)
    mpath = os.path.join(args.out, '_manifest.json')
    manifest = {}
    if os.path.exists(mpath):
        with open(mpath) as f:
            manifest = json.load(f)

    for key in keys:
        spec = FEEDS[key]
        zpath = os.path.join(args.out, f'{key}.zip')
        prev = manifest.get(key, {})
        print(f'[{key}] {spec["url"]}')
        data = fetch(spec['url'])
        sha = hashlib.sha256(data).hexdigest()
        if not args.force and prev.get('sha256') == sha and os.path.exists(zpath):
            print(f'  unchanged (sha256 {sha[:12]}…, {len(data)/1e6:.2f}MB)')
            continue
        with open(zpath, 'wb') as f:
            f.write(data)
        entry = {k: spec[k] for k in
                 ('name', 'operator', 'url', 'catalog', 'license', 'license_url',
                  'attribution', 'pref')}
        entry.update({
            'file': f'{key}.zip',
            'sha256': sha,
            'bytes': len(data),
            'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        })
        entry.update(feed_info(data))
        manifest[key] = entry
        print(f'  saved {zpath} ({len(data)/1e6:.2f}MB, sha256 {sha[:12]}…, '
              f'feed {entry.get("feed_version", "?")})')

    with open(mpath, 'w') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')
    print(f'manifest: {mpath} ({len(manifest)} feeds)')


if __name__ == '__main__':
    main()
