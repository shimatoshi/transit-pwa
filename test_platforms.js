// platform_match.js の単体テスト。Wikipediaから取得した実データに依存しない
// 固定フィクスチャで、番線推定の主要ロジックを検証する。
// 実行: node test_platforms.js
const pm = require('./platform_match.js');

let fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const track = r => (r ? r.t : null);

// 新宿駅ののりば表(実データの抜粋を固定化)
const SHINJUKU = [
  { t: '1・2', line: '湘南新宿ライン', dir: '南行', dest: '横浜・大船・小田原・逗子方面', op: 'JR東日本' },
  { t: '4', line: '湘南新宿ライン', dir: '北行', dest: '大宮・宇都宮・高崎方面', op: 'JR東日本' },
  { t: '11・12', line: '中央線（快速）', dir: '下り', dest: '中野・立川・高尾方面', op: 'JR東日本' },
  { t: '7・8', line: '中央線（快速）', dir: '上り', dest: '御茶ノ水・東京方面', op: 'JR東日本' },
  { t: '14', line: '山手線', dir: '内回り', dest: '原宿・渋谷・品川方面', op: 'JR東日本' },
  { t: '15', line: '山手線', dir: '外回り', dest: '池袋・田端・上野方面', op: 'JR東日本' },
  // 小田急(路線列なし・種別でホームが分かれる)
  { t: '2', dest: '小田原・片瀬江ノ島・唐木田方面', type: '特急ロマンスカー', op: '小田急電鉄' },
  { t: '3', dest: '小田原・片瀬江ノ島・唐木田方面', type: '特急ロマンスカー', op: '小田急電鉄' },
  { t: '4', dest: '小田原・片瀬江ノ島・唐木田方面', type: '快速急行・急行', op: '小田急電鉄' },
  { t: '5', dest: '小田原・片瀬江ノ島・唐木田方面', type: '快速急行・急行', op: '小田急電鉄' },
  { t: '8', dest: '小田原・片瀬江ノ島・唐木田方面', type: '各駅停車', op: '小田急電鉄' },
  { t: '9', dest: '小田原・片瀬江ノ島・唐木田方面', type: '各駅停車', op: '小田急電鉄' },
];

// 単式ホームの駅(方向によらず1番線)
const SINGLE = [
  { t: '1', line: '参宮線', dir: '-', dest: '鳥羽方面', op: 'JR東海' },
];

// --- 路線名の正規化と方向マッチ ---
t('山手線 内回り(ＪＲ全角プレフィックス+方向ヒント)',
  track(pm.matchPlatform(SHINJUKU, 'ＪＲ山手線', ['代々木', '原宿', '渋谷'], '普通')), '14');
t('山手線 外回り',
  track(pm.matchPlatform(SHINJUKU, 'ＪＲ山手線', ['新大久保', '池袋'], '普通')), '15');
t('中央線 下り(「中央線（快速）」への部分一致)',
  track(pm.matchPlatform(SHINJUKU, 'ＪＲ中央線', ['中野', '立川'], '快速')), '11・12');
t('方向ヒントが無く方向を決められない場合は null',
  track(pm.matchPlatform(SHINJUKU, 'ＪＲ山手線', [], '普通')), null);
t('該当路線が無い駅データでは null',
  track(pm.matchPlatform(SHINJUKU, '東急東横線', ['中目黒'], '急行')), null);
t('データ無し(undefined)でも落ちない',
  track(pm.matchPlatform(undefined, 'ＪＲ山手線', ['渋谷'], '普通')), null);

// --- 種別によるホーム分け(小田急方式: 路線列なし・opで事業者マッチ) ---
t('小田急 急行は4・5番線(種別フィルタ+同一方面の結合)',
  track(pm.matchPlatform(SHINJUKU, '小田急小田原線', ['代々木上原', '町田'], '急行')), '4・5');
t('小田急 各駅停車は8・9番線(普通⇔各駅停車の同義語)',
  track(pm.matchPlatform(SHINJUKU, '小田急小田原線', ['南新宿'], '普通')), '8・9');
t('小田急 特急は2・3番線(「特急」→「特急ロマンスカー」の前方一致)',
  track(pm.matchPlatform(SHINJUKU, '小田急小田原線', ['町田', '小田原'], '特急')), '2・3');

// --- 降車ホーム: 来た方向(behind)ペナルティ ---
t('渋谷から着いた山手線は15番線着(内回り側は原宿を含むため除外)',
  track(pm.matchPlatform(SHINJUKU, 'ＪＲ山手線', [], '普通', ['渋谷', '原宿', '代々木'])), '15');
t('池袋から着いた山手線は14番線着',
  track(pm.matchPlatform(SHINJUKU, 'ＪＲ山手線', [], '普通', ['池袋', '新大久保'])), '14');

// --- 単式ホーム: 方向不問で確定 ---
t('候補が1つの番線しか無ければ方向ヒント無しでも確定',
  track(pm.matchPlatform(SINGLE, 'ＪＲ参宮線', [], '普通')), '1');

// --- 新幹線と在来線の区別 ---
const TOKYO = [
  { t: '7・8', line: '上野東京ライン', dir: '下り （北行）', dest: '上野・大宮・宇都宮・高崎・水戸方面', op: 'JR東日本' },
  { t: '9・10', line: '東海道線', dir: '下り', dest: '品川・横浜・小田原・熱海・伊東方面', op: 'JR東日本' },
  { t: '14 - 19', line: '東海道新幹線', dest: '新大阪・博多方面', op: 'JR東海' },
  { t: '20 - 23', line: '東北・北海道新幹線', dir: '下り', dest: '宇都宮・仙台・盛岡・新青森・新函館北斗方面', op: 'JR東日本' },
];
t('東海道・山陽新幹線は在来線の東海道線でなく新幹線ホームに解決',
  track(pm.matchPlatform(TOKYO, 'ＪＲ東海道・山陽新幹線', ['品川', '新大阪'], 'のぞみ')), '14 - 19');
t('在来線の東海道線は新幹線ホームにマッチしない',
  track(pm.matchPlatform(TOKYO, 'ＪＲ東海道本線', ['品川', '横浜'], '普通')), '9・10');
t('東北・北海道新幹線(複合名のトークン照合)',
  track(pm.matchPlatform(TOKYO, 'ＪＲ東北・北海道新幹線', ['上野', '大宮'], 'はやぶさ')), '20 - 23');

// --- 直通系統のエイリアス: 上野東京ライン南行は「東海道線」名義のホームに発着 ---
t('上野東京ライン南行は東海道線名義の9・10番線(方向の証拠が路線名一致に勝つ)',
  track(pm.matchPlatform(TOKYO, 'ＪＲ上野東京ライン', ['新橋', '品川', '熱海'], '普通')), '9・10');
t('上野東京ライン北行は7・8番線',
  track(pm.matchPlatform(TOKYO, 'ＪＲ上野東京ライン', ['上野', '大宮'], '普通')), '7・8');

// --- 表示フォーマット ---
t('formatTrack 単一', pm.formatTrack('14'), '14番線');
t('formatTrack 複合', pm.formatTrack('1・2'), '1・2番線');
t('formatTrack 範囲', pm.formatTrack('20 - 23'), '20-23番線');

console.log(fail === 0 ? '\nPLATFORM ALL OK' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
