// platform_match.js — 駅ののりば表データ(data/platforms.json)と経路のleg情報を
// 照合して、乗車/降車ホーム(番線)を推定する。
//
// platforms.json: { 駅名: [ {t:"番線", line?:"路線名", dir?:"方向", dest?:"方面",
//                            type?:"種別", op?:"事業者見出し"} ] }
// 照合キー: 路線名(正規化) + 進行方向のヒント(その列車がこの駅の後に停まる駅名リスト)
//
// ブラウザ(window)/Node(module.exports)両対応。

(function (global) {
  'use strict';

  // 全角英数→半角、空白除去などの正規化
  function norm(s) {
    if (!s) return '';
    return String(s)
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      })
      .replace(/\s+/g, '')
      .replace(/[（(].*?[)）]/g, '') // 「中央線（快速）」→「中央線」
      .replace(/^JR/i, '')
      .replace(/線$/, '');
  }

  // 路線名同士の一致度: 2=ほぼ一致 1=片方が他方を含む 0=不一致
  function lineScore(entryLine, legLine) {
    var a = norm(entryLine), b = norm(legLine);
    if (!a || !b) return 0;
    // 新幹線と在来線は名前が似ていても別ホーム(「東海道新幹線」vs「東海道線」)
    if (/新幹線/.test(entryLine || '') !== /新幹線/.test(legLine || '')) return 0;
    if (a === b) return 2;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 1;
    // 「東海道・山陽新幹線」のような複合名は「・」で区切って部分一致を試す
    var at = a.split('・'), bt = b.split('・');
    if (at.length > 1 || bt.length > 1) {
      for (var i = 0; i < at.length; i++) {
        for (var j = 0; j < bt.length; j++) {
          var x = at[i], y = bt[j];
          if (x.length < 2 || y.length < 2) continue;
          if (x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return 1;
        }
      }
    }
    return 0;
  }

  // 直通系統は、駅によっては乗り入れ先の路線名でのりば表に載る
  // (東京駅の上野東京ライン南行は「東海道線」ホーム等)。正規化後の名前で引く。
  var LINE_ALIAS = {
    '上野東京ライン': ['東海道', '宇都宮', '高崎', '常磐'],
  };

  // エントリが legLine に対応するか。line が無い表(私鉄系)は op/sec 見出しで判定
  function entryLineScore(e, legLine) {
    var s = lineScore(e.line, legLine);
    if (s) return s;
    if (!e.line) {
      // 新幹線legは事業者見出しにも「新幹線」が無ければマッチさせない
      if (/新幹線/.test(legLine || '') && !/新幹線/.test(e.op || '')) return 0;
      // 見出し(例: 京王電鉄（京王線）)に路線名が含まれるか
      var op = norm(e.op);
      var b = norm(legLine);
      if (op && b && op.indexOf(b) >= 0) return 1;
      // 事業者名一致(小田急電鉄 vs 小田急小田原線)
      if (op && b && b.indexOf(op.replace(/電鉄|鉄道/, '')) >= 0) return 1;
    } else {
      var al = LINE_ALIAS[norm(legLine) + '線'] || LINE_ALIAS[norm(legLine)];
      if (al) {
        var en = norm(e.line);
        for (var i = 0; i < al.length; i++) {
          if (en.indexOf(al[i]) >= 0) return 1;
        }
      }
    }
    return 0;
  }

  // dest/dir テキストに進行方向ヒントの駅名がいくつ含まれるか
  function dirScore(e, aheadStations) {
    if (!aheadStations || !aheadStations.length) return 0;
    var text = (e.dest || '') + ' ' + (e.dir || '');
    var n = 0;
    for (var i = 0; i < aheadStations.length; i++) {
      var st = aheadStations[i];
      if (st && st.length >= 2 && text.indexOf(st) >= 0) n++;
    }
    return n;
  }

  var TYPE_SYNONYM = { '普通': '各駅停車', '各駅停車': '普通', '各停': '各駅停車' };

  // 種別セル(例: "快速急行・急行", "特急ロマンスカー")が legType に該当するか
  function typeMatches(typeText, legType) {
    if (!typeText || !legType) return false;
    var tokens = typeText.split(/[・、\/\s]+/).filter(Boolean);
    var wants = [legType];
    if (TYPE_SYNONYM[legType]) wants.push(TYPE_SYNONYM[legType]);
    for (var i = 0; i < tokens.length; i++) {
      for (var j = 0; j < wants.length; j++) {
        if (tokens[i] === wants[j]) return true;
      }
    }
    // 完全一致が無い場合のみ前方一致(「特急」→「特急ロマンスカー」)。
    // 「快速」→「快速急行」の誤爆を防ぐため、同一セル内に完全一致トークンが
    // 無いときだけ許す(呼び出し側で全エントリ横断の完全一致を優先している)
    for (var k = 0; k < tokens.length; k++) {
      if (tokens[k].indexOf(legType) === 0) return true;
    }
    return false;
  }

  // 同点候補の番線を「1・2・3番線」のようにまとめられるならまとめる
  function combineTracks(cands) {
    var tracks = [];
    for (var i = 0; i < cands.length; i++) {
      var t = cands[i].e.t;
      if (!/^[0-9０-９]+$/.test(t)) return null; // "1・2"等の複合は結合しない
      if (tracks.indexOf(t) < 0) tracks.push(t);
    }
    if (tracks.length < 2 || tracks.length > 3) return null;
    tracks.sort(function (a, b) { return Number(a) - Number(b); });
    return tracks.join('・');
  }

  /**
   * ホーム番線を推定する。
   * @param {Array} entries  platforms.json のその駅のエントリ配列
   * @param {string} legLine  経路legの路線名(例: "ＪＲ山手線")
   * @param {Array<string>} aheadStations  この駅の先で停車する駅名(進行方向ヒント)。
   *   乗車駅なら乗車後の停車駅+終着、降車駅なら列車の終着など。
   * @param {string} [legType]  列車種別(例: "急行", "特急", "普通")
   * @param {Array<string>} [behindStations]  この駅より手前(来た方向)の停車駅。
   *   これを含む方面は逆方向とみなして除外する(降車ホーム推定用)。
   * @returns {{t:string, dest:string}|null}
   */
  function matchPlatform(entries, legLine, aheadStations, legType, behindStations) {
    if (!entries || !entries.length || !legLine) return null;
    var cands = [];
    var maxLine = 0;
    for (var i = 0; i < entries.length; i++) {
      var ls = entryLineScore(entries[i], legLine);
      if (ls > 0) {
        cands.push({ e: entries[i], ls: ls });
        if (ls > maxLine) maxLine = ls;
      }
    }
    if (!cands.length) return null;

    // 種別列を持つ表なら種別で絞る(小田急・京王など種別別ホームの駅)
    if (legType && cands.some(function (c) { return c.e.type; })) {
      var byType = cands.filter(function (c) { return typeMatches(c.e.type, legType); });
      if (byType.length) cands = byType;
    }

    // 方向ヒントでスコアリング(進行方向の駅を含む: +1 / 来た方向の駅を含む: -1)
    for (var j = 0; j < cands.length; j++) {
      cands[j].ds = dirScore(cands[j].e, aheadStations) - dirScore(cands[j].e, behindStations);
    }

    // 方向の証拠がある候補が居ればそれを最優先する。路線名の一致度は
    // その次(直通系統がエイリアス路線名のホームに発着する駅があるため。
    // 例: 東京駅の上野東京ライン南行は「東海道線」名義の9・10番線)
    var withDir = cands.filter(function (c) { return c.ds > 0; });
    var pool;
    if (withDir.length) {
      var maxDs = Math.max.apply(null, withDir.map(function (c) { return c.ds; }));
      pool = withDir.filter(function (c) { return c.ds === maxDs; });
      var maxLs = Math.max.apply(null, pool.map(function (c) { return c.ls; }));
      pool = pool.filter(function (c) { return c.ls === maxLs; });
    } else {
      // 方向の証拠なし: 逆方向らしい候補を外し、路線一致度の高いものに絞る
      pool = cands.filter(function (c) { return c.ds === 0; });
      if (!pool.length) pool = cands; // 全部逆方向扱いなら諦めずに全体で判断
      var ml = Math.max.apply(null, pool.map(function (c) { return c.ls; }));
      pool = pool.filter(function (c) { return c.ls === ml; });
    }

    // 絞った候補が同じ番線なら確定(単式ホーム・終端駅・方向一意など)
    var sameT = pool.every(function (c) { return c.e.t === pool[0].e.t; });
    if (sameT) {
      // 方向の証拠が全く無く、絞り込みも効いていない場合は判定しない
      if (withDir.length || pool.length < cands.length || pool.length === 1) {
        return { t: pool[0].e.t, dest: pool[0].e.dest || '' };
      }
      return null;
    }
    // 同一方面なら複数番線をまとめて表示(京王新宿の1〜3番線など)
    var d0 = pool[0].e.dest || '';
    if (withDir.length || (d0 && pool.every(function (c) { return (c.e.dest || '') === d0; }))) {
      var combined = combineTracks(pool);
      if (combined) return { t: combined, dest: d0 };
    }
    return null; // 方向を決められない場合は表示しない
  }

  // 番線表示用: "1・2" → "1・2番線", "20 - 23" → "20-23番線"
  function formatTrack(t) {
    if (!t) return '';
    var s = String(t).replace(/\s*-\s*/g, '-').replace(/\s+/g, '');
    return s + '番線';
  }

  var api = { matchPlatform: matchPlatform, formatTrack: formatTrack, _norm: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PlatformMatch = api;
})(typeof self !== 'undefined' ? self : this);
