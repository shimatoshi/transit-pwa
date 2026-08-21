#!/bin/bash
cd /data/data/com.termux/files/home/transit-pwa
# スクレイプ完了待ち
while pgrep -f scrape_daytype >/dev/null; do sleep 10; done
echo "=== scrape完了 ==="
tail -2 daytype_scrape.log
[ -f daytype_tx.json ] || { echo "daytype_tx.json 無し(異常終了?)"; exit 1; }
echo "=== タグ付け ==="
python3 tag_calendar.py
echo "=== 再パック ==="
python3 make_trains_v3.py 2>&1 | tail -2
echo "=== 検証: 平日のみ列車が土曜で消えるか(柏→東京 平日vs土) ==="
echo "平日:"; node oneroute.js 柏 東京 8 0 | python3 -c "import json,sys;d=json.load(sys.stdin);print('  ',' / '.join(f'{l[\"from\"]}{l[\"fromT\"]//60:02d}:{l[\"fromT\"]%60:02d}{l[\"line\"]}[{l[\"type\"]}]' for l in d.get('legs',[])))"
echo "土曜:"; node oneroute.js 柏 東京 8 1 | python3 -c "import json,sys;d=json.load(sys.stdin);print('  ',' / '.join(f'{l[\"from\"]}{l[\"fromT\"]//60:02d}:{l[\"fromT\"]%60:02d}{l[\"line\"]}[{l[\"type\"]}]' for l in d.get('legs',[])))"
echo "=== 回帰 ==="
node test_router_v3.js 2>&1 | tail -1
node verify_fares.js 2>&1 | tail -1
# 往復する路線の片方向が落ちていないか。環状運転・特急の見かけ隣接は oneway_allow.json で除外し、
# 残りは probe が「その向きに鉄道で行けるか」まで見る。どちらも落ちたら exit 1。
# tail に食わせるので pipefail が要る(でないと tail の 0 で握り潰される)。
set -o pipefail
node qa_direction.js --check 2>&1 | tail -2 || exit 1
node qa_direction_probe.js 2>&1 | tail -2 || exit 1
set +o pipefail
echo "=== PIPELINE DONE ==="
