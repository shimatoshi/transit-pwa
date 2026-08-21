// Issue #12 の計測: graph_v2.json の駅のうち英字名(e)/かな読み(r)を持たない件数。
// 英字名が無い駅はローマ字で、読みが無い駅はかな・未確定ローマ字で検索できない。
const fs = require('fs'), path = require('path');
const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'graph_v2.json'), 'utf8'));
const st = g.stations;
const rail = st.filter(s => !s.m);

for (const [key, label] of [['e', '英字名(e)'], ['r', '読みがな(r)']]) {
  const miss = st.filter(s => !s[key]);
  const missRail = rail.filter(s => !s[key]);
  console.log(`=== ${label}が無い: ${miss.length} / ${st.length} ` +
    `(鉄道 ${missRail.length}/${rail.length}) ===`);
  if (missRail.length) {
    console.log('  鉄道の例: ' + missRail.slice(0, 24).map(s => s.n).join(' ') +
      (missRail.length > 24 ? ' …' : ''));
  }
}
