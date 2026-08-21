#!/bin/bash
# 全テスト・検証スクリプトを一括実行して結果を要約する。
# 個々のスクリプトは終了コードで合否を返すので、それをそのまま集計する。
cd "$(dirname "$0")"
TESTS_NODE="test_router_v3.js test_bus_router.js test_ui_render.js test_sw_cache.js
            test_seat_fare.js test_express.js verify_fares.js test_platforms.js
            test_operator_filter.js test_station_company.js test_router.js"
TESTS_QA="qa_direction.js:--check qa_direction_probe.js"
LOG="${1:-/tmp/tests.log}"
: > "$LOG"
fail=0
for t in $TESTS_NODE; do
  echo "===== $t" | tee -a "$LOG"
  out=$(timeout 900 node "$t" 2>&1); rc=$?
  echo "$out" >> "$LOG"
  echo "$out" | tail -3
  if [ $rc -ne 0 ]; then echo "  >>> FAIL (rc=$rc) $t" | tee -a "$LOG"; fail=$((fail+1));
  else echo "  >>> PASS $t" | tee -a "$LOG"; fi
done
for spec in $TESTS_QA; do
  t="${spec%%:*}"; arg="${spec#*:}"; [ "$arg" = "$t" ] && arg=""
  echo "===== $t $arg" | tee -a "$LOG"
  out=$(timeout 900 node "$t" $arg 2>&1); rc=$?
  echo "$out" >> "$LOG"
  echo "$out" | tail -3
  if [ $rc -ne 0 ]; then echo "  >>> FAIL (rc=$rc) $t" | tee -a "$LOG"; fail=$((fail+1));
  else echo "  >>> PASS $t" | tee -a "$LOG"; fi
done
echo "===== test_tag_calendar.py" | tee -a "$LOG"
out=$(timeout 900 python3 test_tag_calendar.py 2>&1); rc=$?
echo "$out" >> "$LOG"; echo "$out" | tail -3
if [ $rc -ne 0 ]; then echo "  >>> FAIL (rc=$rc) test_tag_calendar.py" | tee -a "$LOG"; fail=$((fail+1));
else echo "  >>> PASS test_tag_calendar.py" | tee -a "$LOG"; fi
echo "########## FAILED: $fail" | tee -a "$LOG"
exit $fail
