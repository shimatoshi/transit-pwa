#!/bin/bash
# 標準ビルドパイプラインを最初から最後まで通す。
#
# 入力: trains.json (scrape_trains + gapfill_trains + gapfill_reverse の出力。tx を持つ)
#       daytype_keys.json (scrape_daytype_full.py の出力)
#       data/gtfs/*.zip + _manifest.json (fetch_gtfs.py の出力)
#       graph.json / wikidata_stations.json / wikidata_readings.json (各 fetch_*.py の出力)
#
# ネットワークから取り直す段(scrape_trains / scrape_daytype_full / gapfill_* /
# fetch_gtfs / fetch_wikidata / fetch_station_readings / fetch_platforms)は
# 生データが揃っているので回さない。ここは生データ → 配信物の変換だけを通す。
set -e
cd "$(dirname "$0")"

step() { echo; echo "================ $*"; }

step "1/8 tag_calendar.py — 運転日(cal)の付与"
python3 tag_calendar.py

step "2/8 build_graph_trains.py — trains.json から graph_v2.json を再構築"
python3 build_graph_trains.py

step "3/8 fix_coords.py / fix_coords2.py / fix_coords3.py — 座標の補完と汚染修復"
python3 fix_coords.py
python3 fix_coords2.py
python3 fix_coords3.py

step "4/8 patch_station_lines.py — wl(Wikidata実乗り入れ路線)の付与"
python3 patch_station_lines.py

step "5/8 gtfs_to_trains.py — バスGTFS → bus_trips.json + graph_v2 へバス停追記"
python3 gtfs_to_trains.py

step "6/8 patch_station_readings.py — 読みがな r / 英字名 e の付与(バス停含む)"
python3 patch_station_readings.py

step "7/8 make_trains_v3.py — trains_v3.bin(.gz) + trains_v3_meta.json"
python3 make_trains_v3.py

step "8/8 fix_coords4.py — 同名別駅の誤座標修正 + 徒歩連絡の張り直し"
python3 fix_coords4.py

echo
echo "================ PIPELINE DONE"
