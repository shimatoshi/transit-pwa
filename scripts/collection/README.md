# Transit data collection queue

全国の欠落候補・方向別不足・曜日別時刻の調査用。収集結果は別ディレクトリに保存し、`graph_v2.json` の生成や更新は行わない。

## Setup and run

Linux / Python 3.10+ が必要。HTML解析は Beautiful Soup、通常の取得で解析できない駅探ページには Playwright Chromium を使う。

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/collection/requirements.txt
.venv/bin/playwright install chromium
.venv/bin/python -m unittest discover -s scripts/collection -p 'test_*.py'
.venv/bin/python scripts/collection/collector.py seed --root /path/to/collection --config /path/to/plan.json
nohup .venv/bin/python scripts/collection/supervisor.py --root /path/to/collection > /path/to/collection/run.log 2>&1 < /dev/null &
```

`plan.json` は `feeds` と `stations` を必須配列として持つ。任意で `priority_timetables`、`official_sources`、`candidates` を指定できる。

```json
{
  "feeds": [],
  "stations": [{"station_id": "2512", "url": "https://ekitan.com/timetable/railway/station/2512"}],
  "priority_timetables": [],
  "official_sources": [],
  "candidates": []
}
```

GTFS feed は `key`（ファイル名にも使う安全な識別子）、`url`、出典とライセンス情報を指定する。時刻表は `url` と `day`（0:平日、1:土曜、2:休日）を指定する。候補駅は `key`, `name`, `lat`, `lon` を持つ。

## Progress, stop, resume

```sh
.venv/bin/python scripts/collection/collector.py status --root /path/to/collection
.venv/bin/python scripts/collection/collector.py export --root /path/to/collection
kill -TERM "$(cat /path/to/collection/supervisor.pid)"
# 停止後は同じ supervisor コマンドで再開する。
# 原因を直した失敗タスクだけ再試行する場合:
.venv/bin/python scripts/collection/collector.py retry-failed --root /path/to/collection
```

SQLiteに取得キュー・結果・失敗理由を保存する。取得済みのキーは再取得しない。平日・土曜・休日は別キーで保持する。同じ収集ディレクトリでのワーカー二重起動はロックで防ぐ。通常は単一ワーカーで取得前に1.5秒待ち、失敗時は間隔を空けて最大3回試す。異常終了は supervisor が最大3回再起動する。全キューの処理後は終了する有限ジョブで、定期実行ではない。

`status.json` は進捗、`run.log` はイベント、`queue.sqlite` は再開に必要な状態。`gtfs/`、`raw/`、`documents/` に取得元ZIP・圧縮HTML・PDFを保存する。結果には取得URL、取得時刻、SHA-256、曜日、出典情報を残す。`export` で種類別JSONと `candidate-coverage.json` を出力でき、実行中にも使える。

GTFSは必須テーブル・参照整合性・有効期間と鉄道種別を確認する。`no_rail_trips` は路線種別の追加確認が必要な場合も含むため、削除してよいという意味ではない。原データの `route_type=3` を持つ富山市内電車とDMVは自動で鉄道に変換しない。新たに取得した種別未照合の結果には `route_data` と `mode_review_stops` も保持する。

公式サイトのリンク収集は同じドメイン・深さ2・1ページ50件以内に制限する。HTML/PDF取得は時刻表解析の完了を意味しない。PDFは `needs_pdf_parser`、公式サイトHTMLは `needs_source_adapter` として残す。候補駅のGTFS照合も名称と座標による候補一致で、欠落確定やアプリへの追加確定ではない。取得データの再配布条件は出典ごとに確認する。

## 2026-10-08 run

接続先で `/root/transit-collector/code` にコード、`/root/transit-collector/data` に状態と取得データを保存して起動した。初期計画はGTFS 11件、駅探駅ページ199件、優先時刻表15件、公式サイト5件、独立駅一覧との未照合候補491件。時刻表から列車詳細タスクを追加する。

`prepare_config.py` は当日の保存済み調査から計画を生成する補助スクリプト。入力は `transit-pwa-master/graph_v2.json`, `collection-20261008/{audit,station_inventory,timetables}.json`, `gtfs-catalog-current.json`, `station-database/comparison.json`, `mlit-2025/comparison.json`。これらの調査データはこのPRには含めていない。通常利用では上記形式で計画JSONを指定できる。

駅一覧の出典は国土数値情報N02 2025と `Seo-4d696b75/station_database`。後者はREADMEとLICENSEで表記が異なるためLICENSEのCC BY-SA 4.0を記録した。これらの派生候補データ・取得時刻表はコードと別に扱う。
