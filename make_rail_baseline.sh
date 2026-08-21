#!/bin/bash
# test_rail_baseline.json (test_bus_router.js の golden) を作り直す。
#
# golden は「バスを入れる前の鉄道だけのビルド」に対して取る約束なので、
# 一度バス抜きで make_trains_v3.py を回し、その成果物を /tmp/rail に置いてから
# --write-baseline する。終わったらバス入りの成果物を元に戻す。
#
# 鉄道データを意図的に作り直したときだけ実行すること。実行前に
# node qa_baseline_diff.js で全差分が改善であることを目視する。
set -e
cd "$(dirname "$0")"
RAIL=/tmp/rail
HOLD=/tmp/railhold
rm -rf "$RAIL" "$HOLD"; mkdir -p "$RAIL" "$HOLD"

# バス入りの成果物を退避
cp graph_v2.json trains_v3.bin trains_v3.bin.gz trains_v3_meta.json "$HOLD/"
mv bus_trips.json "$HOLD/bus_trips.json"

# graph からバス停(m=1)を落とす。鉄道駅のインデックスは先頭から連続なので不変。
python3 - <<'EOF'
import json
g = json.load(open('graph_v2.json'))
st = g['stations']
n_rail = sum(1 for s in st if not s.get('m'))
assert not any(s.get('m') for s in st[:n_rail]), 'バス停が鉄道駅の間に混ざっている'
del st[n_rail:]
g['stats'] = dict(g.get('stats') or {})
g['stats'].pop('bus_stops', None)
g['stats'].pop('bus_feeds', None)
json.dump(g, open('graph_v2.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print(f'rail-only graph: {n_rail} stations')
EOF

python3 make_trains_v3.py
cp graph_v2.json trains_v3.bin trains_v3_meta.json "$RAIL/"

# バス入りへ戻す
cp "$HOLD/graph_v2.json" "$HOLD/trains_v3.bin" "$HOLD/trains_v3.bin.gz" "$HOLD/trains_v3_meta.json" .
mv "$HOLD/bus_trips.json" bus_trips.json

node test_bus_router.js --write-baseline --data "$RAIL"
echo "=== BASELINE WRITTEN ==="
