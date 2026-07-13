/* 法令星図 — A層(機械抽出・法律網) ＋ B層(手作業・条例/条/判例/運用) 統合
 * - graph.json (A層) と b_layer.json (B層) を読み、bridgesで接続してマージ。
 * - 2D断面(d3・重力井戸の断面) ⇄ 3D重力井戸(3d-force-graph) のビュー切替。
 * - レイヤ切替 A / A＋B / B。詳細パネルはA層=参照網、B層=趣旨・出典・出典未確定の警告。
 * ライブラリはローカルバンドル(web/lib)・CDN依存なし。
 */
(function () {
  "use strict";

  // 法段階(tier): 3Dの縦z ＆ 2DのYへ写像（移植元HTMLの重力井戸TIERを継承）
  var TIER = { "憲法": 240, "法律": 120, "政令": 30, "府省令": -5, "判例": -20, "条例": -95, "歴史": -95, "条": -130, "運用": -200 };
  var TIER_LABEL = {
    "憲法": "憲法", "法律": "法律", "政令": "政令",
    "府省令": "府省令", "判例": "判例", "条例": "条例",
    "条": "条", "運用": "運用", "歴史": "歴史"
  };
  var COLORS = { "憲法": "#ffd700", "法律": "#6ba3ff", "政令": "#ffca5c", "府省令": "#7ddf9a", "条例": "#7ce77c", "条": "#4db5a0", "判例": "#ff8a80", "運用": "#b0bec5", "歴史": "#b388ff" };
  var LEGEND_ORDER = ["憲法", "法律", "政令", "条例", "条", "判例", "運用", "歴史"];
  var EDGE = {
    "a-ref": { color: "#3f4a63", label: "参照（A層・機械抽出）" },
    "nin": { color: "#ffd54f", label: "委任・内包" },
    "koushou": { color: "#ff6e6e", label: "参照（判例経由）" },
    "yakuwari": { color: "#64b5f6", label: "役割分担・隣接" },
    "unyo": { color: "#8fa3c8", label: "運用" },
    "enkaku": { color: "#9e9e9e", label: "沿革" },
    "bridge": { color: "#00e0c0", label: "A⇔B層 接続（同一法令）" }
  };
  var TIER_MAX = 240, TIER_MIN = -200;
  var ZOOM_LABEL_REVEAL = 1.8; // A3: このスケール以上でラベルを全表示（#graph.zoomed-in）
  var ZOOM_AREF_REVEAL = 1.5; // I1-1: このスケール以上でa-ref（背景・参照）のopacityを一段引き上げる（#graph.zoomed-in-aref）

  var $status = document.getElementById("status");
  function setStatus(t) { $status.textContent = t; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // e-Gov法令IDから制定(元号)年を復号（A層のみ・IDの先頭3桁=元号1桁+年2桁）
  var ERA = { "1": { n: "明治", base: 1867 }, "2": { n: "大正", base: 1911 }, "3": { n: "昭和", base: 1925 }, "4": { n: "平成", base: 1988 }, "5": { n: "令和", base: 2018 } };
  function enactYear(id) {
    if (!/^[0-9]/.test(id)) return null;
    var e = ERA[id.charAt(0)]; if (!e) return null;
    var y = parseInt(id.substr(1, 2), 10);
    if (!isFinite(y) || y < 1) return null;
    return { wareki: e.n + y + "年", seireki: e.base + y };
  }

  // A層の法令ID（e-Gov法令ID・graph.jsonの id フィールド）からe-Gov条文URLを機械生成
  function egovUrl(lawId) { return "https://laws.e-gov.go.jp/law/" + lawId; }

  function fetchFirst(cands) {
    var i = 0;
    function next() {
      if (i >= cands.length) return Promise.reject(new Error(cands[0] + " 系が見つかりません"));
      var url = cands[i++];
      return fetch(url).then(function (r) { if (!r.ok) throw 0; return r.json(); }).catch(function () { return next(); });
    }
    return next();
  }
  var A_CANDS = ["../data/output/graph.json", "data/output/graph.json", "./graph.json", "graph.json"];
  var B_CANDS = ["b_layer.json", "./b_layer.json", "web/b_layer.json"];

  Promise.all([fetchFirst(A_CANDS), fetchFirst(B_CANDS)]).then(init).catch(function (err) {
    setStatus("読み込み失敗: " + err.message); console.error(err);
  });

  // ============================ 統合 ============================
  var ALL = { nodes: [], links: [] }, byId = {}, aMeta = null;

  function init(res) {
    var ga = res[0], gb = res[1]; aMeta = ga._meta || {};

    // A層ノード
    ga.nodes.forEach(function (n) {
      var t = n.type || "法律";
      ALL.nodes.push({ id: n.id, name: n.name, type: t, layer: "A", tier: (TIER[t] != null ? TIER[t] : 30), era: n.era, nrefs: n.nrefs, _w: n.nrefs });
    });
    // B層ノード
    gb.nodes.forEach(function (n) {
      ALL.nodes.push({ id: n.id, name: n.name, type: n.type, layer: "B", tier: (n.tier != null ? n.tier : (TIER[n.type] || -95)), val: n.val, desc: n.desc, src: n.src, text: n.text, warn: !!n.warn, parent: n.parent, _w: n.val || 3 });
    });
    ALL.nodes.forEach(function (n) { byId[n.id] = n; n._adj = []; });

    // A層リンク（参照・weight=参照回数）
    ga.links.forEach(function (l) { pushLink(l.source, l.target, l.weight, "a-ref", null); });
    // B層リンク（rel/kind）
    gb.links.forEach(function (l) { pushLink(l.source, l.target, l.thin ? 1 : 2, l.kind || "nin", l.rel, l.thin); });
    // bridges（A⇔B 同一法令）
    (gb.bridges || []).forEach(function (b) { pushLink(b.a_id, b.b_id, 2, "bridge", b.rel); });

    // 決定的な帯内順序（バリセンタ法）を全ノード・全エッジから一度だけ計算し _oxFrac に保持。
    computeLayerOrder();

    // 半径スケール（層ごと＝可読性）
    var aMaxW = d3.max(ALL.nodes.filter(byLayer("A")), function (d) { return d._w; }) || 1;
    var bMaxW = d3.max(ALL.nodes.filter(byLayer("B")), function (d) { return d._w; }) || 1;
    var rA = d3.scaleSqrt().domain([1, aMaxW]).range([3.5, 18]).clamp(true);
    var rB = d3.scaleSqrt().domain([1, bMaxW]).range([5, 16]).clamp(true);
    ALL.nodes.forEach(function (d) { d._r = (d.layer === "A") ? rA(d._w) : rB(d._w); d._v3 = (d.layer === "A") ? Math.max(2, d._w / 5) : Math.max(3, d._w); });

    buildLegend();
    buildFilters();
    document.getElementById("fhead").addEventListener("click", function () { document.getElementById("fbox").classList.toggle("collapsed"); });
    document.getElementById("filter-reset").addEventListener("click", resetFilters);
    // I1-2: 狭幅（〜430px）はフィルタを既定閉で開始（#fheadが開閉トグル）。
    try { if (window.matchMedia && window.matchMedia("(max-width: 430px)").matches) document.getElementById("fbox").classList.add("collapsed"); } catch (e) {}

    window.__lawmap = {
      ALL: ALL, state: state, count2d: count2d, count3d: count3d, filtered: null,
      select: selectNode,
      transform2d: function () { var t = document.querySelector("#graph .root"); return t ? t.getAttribute("transform") : null; },
      simAlpha: function () { return sim2d ? sim2d.alpha() : null; } // 力学の沈静化(alphaMin未満)を外部から確認するための検証用フック
    };
    applyControls();
    // UIの2D⇄3D切替は撤去し既定2Dのみ。?mode=3d のときだけ隠しモードとして3Dへ入る（UI上は非言及）。
    var initMode = "2d";
    try { if (new URLSearchParams(window.location.search).get("mode") === "3d") initMode = "3d"; } catch (e) {}
    setView(initMode); // 初期描画
  }

  function pushLink(s, t, w, kind, rel, thin) {
    var a = byId[s], b = byId[t]; if (!a || !b) return; // dangling防御
    var L = { source: s, target: t, weight: w || 1, kind: kind, rel: rel, thin: !!thin };
    ALL.links.push(L);
    a._adj.push({ other: b, rel: rel, weight: w || 1, dir: "out", kind: kind });
    b._adj.push({ other: a, rel: rel, weight: w || 1, dir: "in", kind: kind });
  }
  function byLayer(L) { return function (n) { return n.layer === L; }; }

  // ============================ 決定的レイアウト（バリセンタ法） ============================
  // このグラフは実質レイヤードグラフ（縦=tier帯固定）。隣接する帯どうしのバリセンタ（重心）法で
  // 各帯内のノードの横順序を数回スイープして決め、_oxFrac（0〜1の帯内位置）として保持する。
  // 乱数は一切使わない決定的計算＝リロードのたびに同じ順序・同じ配置になる。
  // 全ノード・全エッジ（ALL＝フィルタ前）から一度だけ計算するため、エッジ既定OFFの影響を受けない。
  function computeLayerOrder() {
    var tierSet = {};
    ALL.nodes.forEach(function (n) { tierSet[n.tier] = 1; });
    var bandTiers = Object.keys(tierSet).map(Number).sort(function (a, b) { return b - a; }); // 上(高tier)→下

    var order = []; // order[bandIndex] = [id,...]（帯内の現在順序）
    bandTiers.forEach(function (t, i) {
      var ids = ALL.nodes.filter(function (n) { return n.tier === t; }).map(function (n) { return n.id; });
      ids.sort(); // 決定的な初期シード（id辞書順）
      order[i] = ids;
    });
    var posOf = {}; // id -> {band, idx}
    function reindexBand(bi) { order[bi].forEach(function (id, idx) { posOf[id] = { band: bi, idx: idx }; }); }
    bandTiers.forEach(function (t, i) { reindexBand(i); });

    var adj = {}; ALL.nodes.forEach(function (n) { adj[n.id] = []; });
    ALL.links.forEach(function (l) { if (adj[l.source] && adj[l.target]) { adj[l.source].push(l.target); adj[l.target].push(l.source); } });

    var NSWEEPS = 8; // 数回スイープ（下向き/上向きを交互）
    for (var s = 0; s < NSWEEPS; s++) {
      var down = (s % 2 === 0);
      var seq = []; for (var k = 0; k < bandTiers.length; k++) seq.push(down ? k : bandTiers.length - 1 - k);
      seq.forEach(function (bi) {
        var refBi = down ? bi - 1 : bi + 1; // 隣接層のみを参照
        if (refBi < 0 || refBi >= bandTiers.length) return; // 端の帯（参照先なし）はこのスイープで順序維持
        var scored = order[bi].map(function (id, idx) {
          var neigh = adj[id].filter(function (nid) { return posOf[nid] && posOf[nid].band === refBi; });
          var bary;
          if (!neigh.length) bary = idx; // 隣接帯に接続が無いノードは現順序を維持（安定ソート）
          else { var sum = 0; neigh.forEach(function (nid) { sum += posOf[nid].idx; }); bary = sum / neigh.length; }
          return { id: id, bary: bary, idx: idx };
        });
        scored.sort(function (a, b) { return (a.bary - b.bary) || (a.idx - b.idx); });
        order[bi] = scored.map(function (o) { return o.id; });
        reindexBand(bi);
      });
    }
    bandTiers.forEach(function (t, i) {
      var n = order[i].length;
      order[i].forEach(function (id, idx) { var d = byId[id]; if (d) d._oxFrac = n > 1 ? (idx + 0.5) / n : 0.5; });
    });
  }

  // ============================ フィルタ ============================
  // types/eras/edgeKinds は「offにされた値」を false で持つ（未登録=表示）。
  // エッジ既定の整理。a-ref（A層・機械抽出の参照）は全エッジの9割超を占めるが、これを既定OFFにすると
  // 参照網（法律マップの本体）を持たないA層ノードの大半が孤立表示になるため既定ONに戻す。
  // 見苦しさ対策は非表示にせず描画側で担う＝a-refは薄く細く背景に、B層・bridge・委任系は前景に（render2D参照）。
  var DEFAULT_EDGE_OFF = [];
  function defaultEdgeKinds() { var o = {}; DEFAULT_EDGE_OFF.forEach(function (k) { o[k] = false; }); return o; }
  var state = { view: "2d", layer: "AB", types: {}, eras: {}, edgeKinds: defaultEdgeKinds(), showBLayer: true };

  function getData() {
    var showA = state.layer === "A" || state.layer === "AB";
    var showB = (state.layer === "B" || state.layer === "AB") && state.showBLayer;
    var nodes = ALL.nodes.filter(function (n) {
      if (n.layer === "A" && !showA) return false;
      if (n.layer === "B" && !showB) return false;
      if (state.types[n.type] === false) return false;               // 法段階フィルタ
      if (n.layer === "A" && n.era && state.eras[n.era] === false) return false; // 年代フィルタ（A層のみ）
      return true;
    });
    var idset = {}; nodes.forEach(function (n) { idset[n.id] = 1; });
    var links = ALL.links.filter(function (l) {
      if (state.edgeKinds[l.kind] === false) return false;           // エッジ種別トグル
      if (l.kind === "bridge" && state.layer !== "AB") return false;
      return idset[l.source] && idset[l.target];
    });
    return { nodes: nodes, links: links };
  }

  function tierY(tier, H, pad) {
    return pad + (TIER_MAX - tier) / (TIER_MAX - TIER_MIN) * (H - 2 * pad);
  }

  // ============================ 凡例 ============================
  function buildLegend() {
    var el = document.getElementById("type-legend"); el.innerHTML = "";
    // I1-2: 狭幅ではヘッダーの凡例を隠し、フィルタ内の複製(#type-legend-mobile)を表示する。中身は同一のため複製生成。
    var elMobile = document.getElementById("type-legend-mobile"); if (elMobile) elMobile.innerHTML = "";
    LEGEND_ORDER.forEach(function (t) {
      if (!ALL.nodes.some(function (n) { return n.type === t; })) return;
      var s = document.createElement("span"); s.className = "sw";
      s.innerHTML = '<i style="background:' + COLORS[t] + '"></i>' + t;
      el.appendChild(s);
      if (elMobile) elMobile.appendChild(s.cloneNode(true));
    });
  }

  // ============================ ビュー/レイヤ切替 ============================
  function applyControls() {
    document.querySelectorAll("#view-toggle button").forEach(function (b) {
      b.addEventListener("click", function () { setView(b.getAttribute("data-view")); });
    });
    // レイヤ制御（A/A+B/B）はフィルタパネル内 #f-layer へ統合（旧ヘッダー独立3ボタンは撤去）。
    document.querySelectorAll("#f-layer .layer-chip").forEach(function (b) {
      b.addEventListener("click", function () {
        state.layer = b.getAttribute("data-layer");
        document.querySelectorAll("#f-layer .layer-chip").forEach(function (x) { x.classList.toggle("on", x === b); });
        var bchk = document.getElementById("f-blayer"); if (bchk) bchk.checked = (state.layer !== "A") && state.showBLayer;
        // A層単独ではa-ref（A層参照）以外のエッジ種別が存在しない。手動でOFFにしたままA層単独へ切替えるとエッジ0本になるため自動ONで救済する。
        if (state.layer === "A" && state.edgeKinds["a-ref"] === false) enableEdgeKind("a-ref");
        activeQ = null; selected = null; closePanel(); renderActive();
      });
    });
  }
  function setView(v) {
    state.view = v;
    document.querySelectorAll("#view-toggle button").forEach(function (x) { x.classList.toggle("on", x.getAttribute("data-view") === v); });
    document.getElementById("graph").hidden = (v !== "2d");
    document.getElementById("graph3d").hidden = (v !== "3d");
    selected = null; closePanel(); renderActive();
  }
  function renderActive() {
    var data = getData();
    window.__lawmap.filtered = data;
    if (state.view === "2d") render2D(data); else render3D(data);
    var na = data.nodes.filter(byLayer("A")).length, nb = data.nodes.filter(byLayer("B")).length;
    setStatus("表示 " + state.view.toUpperCase() + " ／ レイヤ " + state.layer +
      " ｜ ノード " + data.nodes.length + "（A:" + na + " / B:" + nb + "）｜ エッジ " + data.links.length +
      " ｜ A層生成 " + (aMeta.generated || "?"));
  }

  // ============================ 2D (d3) ============================
  var sim2d = null, node2d = null, link2d = null, zoom2d = null, nodesData2d = null;
  var activeQ = null; // 現在アクティブな強調表示のIDセット（null=なし）
  function render2D(data) {
    var svg = d3.select("#graph"); svg.selectAll("*").remove();
    if (sim2d) { sim2d.stop(); sim2d = null; }
    var stage = document.getElementById("stage");
    var W = stage.clientWidth, H = stage.clientHeight, pad = 46;
    svg.attr("viewBox", "0 0 " + W + " " + H);

    // データのコピー（d3が破壊するため）
    var nodes = data.nodes.map(function (n) { return Object.assign({}, n); });
    var nmap = {}; nodes.forEach(function (n) { nmap[n.id] = n; });
    var links = data.links.map(function (l) { return { source: l.source, target: l.target, weight: l.weight, kind: l.kind, rel: l.rel, thin: l.thin }; });
    // 背景(a-ref=A層参照)を先に、前景(B層・bridge・委任系)を後に描画する（SVGは後勝ち＝描画順で上に乗る）。
    // kindのみに依存する決定的な安定分割（乱数なし）＝リロードのたびに同じ描画順になる。
    links = links.filter(function (l) { return l.kind === "a-ref"; }).concat(links.filter(function (l) { return l.kind !== "a-ref"; }));
    var neighbors = {}; nodes.forEach(function (n) { neighbors[n.id] = {}; });
    links.forEach(function (l) { neighbors[l.source][l.target] = 1; neighbors[l.target][l.source] = 1; });

    var wMax = d3.max(links, function (d) { return d.weight; }) || 1;
    // a-ref既定ON化(H2)：本数が支配的（9割超）なため背景として薄く細く描く。B層・bridge・委任系は前景として太く濃く。
    // I1-1: 0.06〜0.18は標準ディスプレイで視認困難という指摘を受け引き上げ。前景edge-fg(0.75)との階層は維持。
    var wScale = d3.scaleSqrt().domain([1, wMax]).range([0.35, 1.6]).clamp(true);
    var oScale = d3.scaleSqrt().domain([1, wMax]).range([0.16, 0.35]).clamp(true);
    var oScaleZoomed = d3.scaleSqrt().domain([1, wMax]).range([0.30, 0.55]).clamp(true); // ZOOM_AREF_REVEAL以上でのみ使う
    function lw(d) { return d.kind === "a-ref" ? wScale(d.weight) : (d.thin ? 0.6 : (d.kind === "bridge" ? 2.2 : 1.8)); }

    var root = svg.append("g").attr("class", "root");
    var gBands = root.append("g").attr("class", "bands");
    var gLinks = root.append("g").attr("class", "links");
    var gNodes = root.append("g").attr("class", "nodes");

    // 法段階の帯（同じtier値の型はラベル併記＝A1: 条例/歴史が同tier=-95で重複するため）
    var tierGroups = {}; var tierValues = [];
    nodes.forEach(function (n) {
      var tv = TIER[n.type] != null ? TIER[n.type] : n.tier;
      if (!tierGroups[tv]) { tierGroups[tv] = []; tierValues.push(tv); }
      if (tierGroups[tv].indexOf(n.type) < 0) tierGroups[tv].push(n.type);
    });
    tierValues.sort(function (a, b) { return b - a; });
    var bandData = tierValues.map(function (tv) { return { tier: tv, label: tierGroups[tv].map(function (t) { return TIER_LABEL[t] || t; }).join("／") }; });
    var bands = gBands.selectAll("g.band").data(bandData).enter().append("g").attr("class", "band");
    bands.append("line").attr("class", "band-line").attr("x1", 0).attr("x2", W).attr("y1", function (d) { return tierY(d.tier, H, pad); }).attr("y2", function (d) { return tierY(d.tier, H, pad); });
    bands.append("text").attr("class", "band-label").attr("x", 14).attr("y", function (d) { return tierY(d.tier, H, pad) - 8; }).text(function (d) { return d.label; });

    // 決定的な初期配置。x はバリセンタ法で求めた帯内順序（_oxFrac・init()で一度だけ計算）から、
    // y は帯のY座標そのもの。乱数は使わない＝リロードのたびに同じ配置になる。
    function orderX(d) { return pad + (d._oxFrac != null ? d._oxFrac : 0.5) * (W - 2 * pad); }
    nodes.forEach(function (d) { d.y = tierY(d.tier, H, pad); d.x = orderX(d); });

    // A4: ノード数が多い帯（法律≈150）はforceYを緩め、collide/chargeで縦にも広がる帯にする（1本の線への圧縮を回避）
    var typeCounts = {};
    nodes.forEach(function (n) { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
    function yStrength(d) { return (typeCounts[d.type] || 0) > 40 ? 0.35 : 0.95; }

    // 力学は微調整役に格下げ。x はバリセンタ順序(orderX)を弱めに保持するに留め（強すぎると
    // 同一帯内エッジ＝この星図の大半を占めるa-ref＝の局所的な再配置がforce任せにできなくなり逆効果と実測）、
    // charge/collideによる局所的な混雑解消を主役として残す。strength値は実測（交差数メトリクス）で決定。
    sim2d = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(function (d) { return d.id; }).distance(function (l) { return l.kind === "a-ref" ? 70 : 55; }).strength(0.08))
      .force("charge", d3.forceManyBody().strength(-130).distanceMax(600))
      .force("x", d3.forceX(orderX).strength(0.08))
      .force("y", d3.forceY(function (d) { return tierY(d.tier, H, pad); }).strength(yStrength))
      .force("collide", d3.forceCollide().radius(function (d) { return d._r + 4; }).iterations(3))
      .alpha(1).alphaDecay(0.022);

    var link = gLinks.selectAll("line").data(links).enter().append("line")
      .attr("class", function (d) { return d.kind === "a-ref" ? "link edge-bg" : "link edge-fg"; })
      .attr("stroke", function (d) { return (EDGE[d.kind] || EDGE["a-ref"]).color; })
      .attr("stroke-width", lw)
      .attr("stroke-dasharray", function (d) { return d.kind === "bridge" ? "4 3" : null; })
      .attr("stroke-opacity", function (d) { return d.kind === "a-ref" ? oScale(d.weight) : 0.75; });

    var node = gNodes.selectAll("g.node").data(nodes).enter().append("g").attr("class", "node");
    node.append("circle").attr("r", function (d) { return d._r; })
      .attr("fill", function (d) { return COLORS[d.type] || "#9aa7bd"; })
      .attr("stroke", function (d) { return d.warn ? "#ff5252" : (d.layer === "B" ? "#0b0e16" : "none"); })
      .attr("stroke-width", function (d) { return d.warn ? 2 : (d.layer === "B" ? 1 : 0); });
    // A3: 常時ラベルは次数上位のみ（A層=被参照数上位14／B層=重要度val上位12）。それ以外はCSS既定で非表示にし、
    // ホバー（.sel付与＝既存hi()を流用）／ズーム（#graph.zoomed-in）連動で表示する。
    var aThresh = nodes.filter(byLayer("A")).map(function (d) { return d.nrefs; }).sort(function (a, b) { return b - a; })[13] || 0;
    var bVals = nodes.filter(byLayer("B")).map(function (d) { return d._w; }).sort(function (a, b) { return b - a; });
    var bThresh = bVals.length ? bVals[Math.min(11, bVals.length - 1)] : 0;
    function isTopDeg(d) { return d.layer === "B" ? d._w >= bThresh : d.nrefs >= aThresh; }
    node.append("text").attr("class", function (d) { return "node-label" + (isTopDeg(d) ? " always" : ""); })
      .attr("dy", function (d) { return -d._r - 4; }).text(function (d) { return d.name; });

    node.call(d3.drag()
      .on("start", function (e, d) { if (!e.active) sim2d.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", function (e, d) { d.fx = e.x; d.fy = e.y; })
      .on("end", function (e, d) { if (!e.active) sim2d.alphaTarget(0); d.fx = null; d.fy = null; }));

    sim2d.on("tick", function () {
      link.attr("x1", function (d) { return d.source.x; }).attr("y1", function (d) { return d.source.y; }).attr("x2", function (d) { return d.target.x; }).attr("y2", function (d) { return d.target.y; });
      node.attr("transform", function (d) { return "translate(" + d.x + "," + d.y + ")"; });
    });

    var zoom = d3.zoom().scaleExtent([0.2, 6]).on("zoom", function (e) {
      root.attr("transform", e.transform);
      svg.classed("zoomed-in", e.transform.k >= ZOOM_LABEL_REVEAL);
      var arefIn = e.transform.k >= ZOOM_AREF_REVEAL;
      svg.classed("zoomed-in-aref", arefIn);
      link.filter(function (d) { return d.kind === "a-ref"; })
        .attr("stroke-opacity", function (d) { return (arefIn ? oScaleZoomed : oScale)(d.weight); });
    });
    svg.call(zoom);
    node2d = node; link2d = link; zoom2d = zoom; nodesData2d = nodes;

    var tip = document.getElementById("tooltip");
    node.on("mousemove", function (e, d) {
      tip.hidden = false; tip.innerHTML = tooltipHTML(d);
      var r = stage.getBoundingClientRect(); var px = e.clientX - r.left + 14, py = e.clientY - r.top + 14;
      if (px + 300 > r.width) px = e.clientX - r.left - 300;
      tip.style.left = px + "px"; tip.style.top = py + "px";
      hi(d.id);
    }).on("mouseleave", function () { tip.hidden = true; if (activeQ) hiSet(activeQ); else if (selected) hi(selected.id); else clearHi(); })
      .on("click", function (e, d) { e.stopPropagation(); activeQ = null; selectNode(byId[d.id]); });

    svg.on("click", function () { selected = null; activeQ = null; clearHi(); closePanel(); });

    function hi(id) {
      var nb = neighbors[id] || {};
      node.classed("dim", function (o) { return o.id !== id && !nb[o.id]; });
      link.classed("dim", function (l) { return !(l.source.id === id || l.target.id === id); });
      node.classed("sel", function (o) { return o.id === id; });
    }
    function hiSet(ids) {
      var s = {}; ids.forEach(function (i) { s[i] = 1; });
      node.classed("dim", function (o) { return !s[o.id]; });
      node.classed("sel", function (o) { return !!s[o.id]; });
      link.classed("dim", function (l) { var a = l.source.id || l.source, b = l.target.id || l.target; return !(s[a] && s[b]); });
    }
    function clearHi() { node.classed("dim", false); link.classed("dim", false); node.classed("sel", false); }
    render2D._hi = hi; render2D._clear = clearHi; render2D._hiSet = hiSet;

    if (activeQ) hiSet(activeQ); // 再描画後にアクティブな強調表示を復元

    window.addEventListener("resize", onResize2D);
    function onResize2D() {
      if (document.getElementById("graph").hidden) return;
      W = stage.clientWidth; H = stage.clientHeight; svg.attr("viewBox", "0 0 " + W + " " + H);
      bands.select("line").attr("x2", W).attr("y1", function (d) { return tierY(d.tier, H, pad); }).attr("y2", function (d) { return tierY(d.tier, H, pad); });
      bands.select("text").attr("y", function (d) { return tierY(d.tier, H, pad) - 8; });
      sim2d.force("y", d3.forceY(function (d) { return tierY(d.tier, H, pad); }).strength(yStrength))
        .force("x", d3.forceX(orderX).strength(0.08))
        .alpha(0.3).restart();
    }
  }

  // ============================ 3D (3d-force-graph) ============================
  var g3d = null, sprites = [];
  function ensure3D() {
    if (g3d) return g3d;
    var el = document.getElementById("graph3d");
    g3d = ForceGraph3D()(el)
      .backgroundColor("#05070f")
      .nodeLabel(function (n) { return n.name; })
      .nodeColor(function (n) { return (activeQ && activeQ.indexOf(n.id) < 0) ? "#28324a" : (COLORS[n.type] || "#9aa7bd"); })
      .nodeVal(function (n) { return n._v3; })
      .nodeOpacity(0.95)
      .linkColor(function (l) {
        var base = (EDGE[l.kind] || EDGE["a-ref"]).color;
        if (activeQ) { var a = (l.source.id || l.source), b = (l.target.id || l.target); if (activeQ.indexOf(a) < 0 || activeQ.indexOf(b) < 0) return "#1a2236"; }
        return base;
      })
      .linkWidth(function (l) { return l.kind === "a-ref" ? Math.min(1.2, 0.2 + l.weight / 200) : (l.thin ? 0.2 : (l.kind === "bridge" ? 1.2 : 0.8)); })
      .linkOpacity(0.45)
      .linkLabel(function (l) { return l.rel ? esc(l.rel) : ((EDGE[l.kind] || {}).label || ""); })
      .linkDirectionalParticles(function (l) { return l.kind === "bridge" ? 3 : 0; })
      .linkDirectionalParticleWidth(1.6)
      .onNodeClick(function (n) { selectNode(byId[n.id]); focus3D(n); });
    g3d.d3Force("charge").strength(-170);
    return g3d;
  }
  function render3D(data) {
    var el = document.getElementById("graph3d"), stage = document.getElementById("stage");
    var G = ensure3D();
    G.width(stage.clientWidth).height(stage.clientHeight);
    // 重力井戸：z を tier に固定（層状）
    var nodes = data.nodes.map(function (n) { var c = Object.assign({}, n); c.fz = n.tier; return c; });
    var links = data.links.map(function (l) { return { source: l.source, target: l.target, weight: l.weight, kind: l.kind, rel: l.rel, thin: l.thin }; });
    G.graphData({ nodes: nodes, links: links });
    // tier ラベルスプライトを貼り替え
    var scene = G.scene();
    sprites.forEach(function (s) { scene.remove(s); }); sprites = [];
    var seen = {};
    nodes.forEach(function (n) { seen[n.type] = 1; });
    Object.keys(seen).sort(function (a, b) { return TIER[b] - TIER[a]; }).forEach(function (t) { addTierLabel(scene, TIER_LABEL[t] || t, TIER[t]); });
    G.cameraPosition({ x: 0, y: -60, z: 620 }, { x: 0, y: 0, z: 0 }, 0);
  }
  function focus3D(n) { if (!g3d) return; var d = Math.hypot(n.x || 0, n.y || 0, (n.z || n.fz || 0)) || 1; var r = 1 + 180 / d; g3d.cameraPosition({ x: (n.x || 0) * r, y: (n.y || 0) * r, z: (n.z || n.fz || 0) + 180 }, n, 800); }
  function addTierLabel(scene, text, z) {
    var cv = document.createElement("canvas"); cv.width = 640; cv.height = 72; var ctx = cv.getContext("2d");
    ctx.font = '400 30px "Yu Gothic", Meiryo, sans-serif'; ctx.fillStyle = "rgba(143,163,200,0.55)"; ctx.fillText(text, 8, 46);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
    sp.scale.set(200, 22, 1); sp.position.set(-340, 0, z); scene.add(sp); sprites.push(sp);
  }

  // ============================ 詳細パネル（共通） ============================
  var panel = document.getElementById("panel"), selected = null;
  document.getElementById("panel-close").addEventListener("click", function () { selected = null; activeQ = null; clearActiveHi(); closePanel(); });
  function closePanel() { panel.classList.add("empty"); panel.querySelector(".panel-body").hidden = true; }
  function clearActiveHi() { if (state.view === "2d") { if (render2D._clear) render2D._clear(); } else { refresh3D(); } }

  function tooltipHTML(d) {
    if (d.layer === "A") { var y = enactYear(d.id); return '<div class="t-name">' + esc(d.name) + '</div><div class="t-meta">' + d.type + "・" + d.era + (y ? " " + y.wareki : "") + "／被参照 " + d.nrefs + "</div>"; }
    return '<div class="t-name">' + esc(d.name) + '</div><div class="t-meta">' + d.type + (d.warn ? " ・出典未確定" : "") + "</div>";
  }

  function selectNode(d) {
    if (!d) return; selected = d;
    if (state.view === "2d") { if (activeQ && render2D._hiSet) render2D._hiSet(activeQ); else if (render2D._hi) render2D._hi(d.id); }
    panel.classList.remove("empty"); panel.querySelector(".panel-body").hidden = false;
    document.getElementById("p-name").textContent = d.name;
    var pillColor = COLORS[d.type] || "#9aa7bd";
    document.getElementById("p-cat").innerHTML = '<span class="tier-pill" style="background:' + pillColor + '22;color:' + pillColor + '">' + d.type + "</span>" +
      '<span class="layer-tag">' + (d.layer === "A" ? "A層・機械抽出" : "B層・一次資料移植") + "</span>";

    var warnEl = document.getElementById("p-warn");
    if (d.warn) { warnEl.hidden = false; warnEl.innerHTML = "判例集の正式な出典（巻号・頁・事件番号）が未確定のため、記載内容は断定を避けています。"; }
    else { warnEl.hidden = true; warnEl.textContent = ""; }

    var descEl = document.getElementById("p-desc");
    if (d.desc) { descEl.hidden = false; descEl.textContent = d.desc; } else { descEl.hidden = true; }

    var textWrap = document.getElementById("p-text-wrap"), textEl = document.getElementById("p-text");
    if (d.text) { textWrap.hidden = false; textEl.textContent = d.text; } else { textWrap.hidden = true; textEl.textContent = ""; }

    var meta = document.getElementById("p-meta");
    if (d.layer === "A") {
      var y = enactYear(d.id);
      meta.innerHTML = "<dt>正式名</dt><dd>" + esc(d.name) + "</dd>" +
        "<dt>法段階</dt><dd>" + d.type + "</dd>" +
        "<dt>制定年</dt><dd>" + (y ? y.wareki + "（" + y.seireki + "年）" : "不明") + "</dd>" +
        "<dt>被参照数</dt><dd>" + d.nrefs + " 法令</dd>" +
        '<dt>法令ID</dt><dd style="color:var(--muted);font-size:11px">' + d.id + "</dd>";
    } else {
      meta.innerHTML = "<dt>種別</dt><dd>" + d.type + (d.parent ? "（" + esc(byId[d.parent] ? byId[d.parent].name : d.parent) + "）" : "") + "</dd>";
    }

    var srcEl = document.getElementById("p-src");
    var srcHtml = "";
    if (d.layer === "A") {
      srcHtml += '<div class="src-line"><a class="src-link" href="' + esc(egovUrl(d.id)) + '" target="_blank" rel="noopener noreferrer">e-Govで条文を読む</a></div>';
    }
    if (d.src) {
      d.src.split("／").forEach(function (part) {
        part = part.trim();
        if (!part) return;
        var m = /https?:\/\/\S+/.exec(part);
        if (m) {
          var label = (part.slice(0, m.index) + part.slice(m.index + m[0].length)).trim();
          srcHtml += '<div class="src-line">' + esc(label) + ' <a class="src-link" href="' + esc(m[0]) + '" target="_blank" rel="noopener noreferrer">出典を開く</a></div>';
        } else {
          srcHtml += '<div class="src-line">出典：' + esc(part) + '</div>';
        }
      });
    }
    if (srcHtml) { srcEl.hidden = false; srcEl.innerHTML = srcHtml; } else { srcEl.hidden = true; srcEl.textContent = ""; }

    // 関係リスト
    if (d.layer === "A") {
      var outs = d._adj.filter(function (a) { return a.dir === "out" && a.kind === "a-ref"; }).sort(byW).slice(0, 5);
      var ins = d._adj.filter(function (a) { return a.dir === "in" && a.kind === "a-ref"; }).sort(byW).slice(0, 5);
      document.getElementById("p-out-h").textContent = "参照先 上位5（この法令が引く）";
      document.getElementById("p-in-h").textContent = "参照元 上位5（この法令を引く）";
      fillRefs("p-out", "p-out-wrap", outs, true);
      fillRefs("p-in", "p-in-wrap", ins, true);
    } else {
      var rel = d._adj.slice().sort(function (a, b) { return (a.dir === "out" ? 0 : 1) - (b.dir === "out" ? 0 : 1); });
      document.getElementById("p-out-h").textContent = "関係（このノードに接続する法令・条・判例）";
      fillRefs("p-out", "p-out-wrap", rel, false);
      document.getElementById("p-in-wrap").hidden = true;
    }
  }
  function byW(a, b) { return b.weight - a.weight; }
  function fillRefs(olId, wrapId, arr, isA) {
    var wrap = document.getElementById(wrapId), ol = document.getElementById(olId);
    wrap.hidden = false; ol.innerHTML = "";
    if (!arr.length) { wrap.hidden = true; return; }
    arr.forEach(function (r) {
      var li = document.createElement("li");
      if (isA) { li.innerHTML = esc(r.other.name) + '<span class="w">×' + r.weight + "</span>"; }
      else {
        var arrow = r.dir === "out" ? "→" : "←";
        var kc = (EDGE[r.kind] || EDGE["a-ref"]).color;
        li.innerHTML = '<span class="arrow" style="color:' + kc + '">' + arrow + "</span>" + esc(r.other.name) + (r.rel ? '<span class="rel">' + esc(r.rel) + "</span>" : "");
      }
      li.addEventListener("click", function () { var t = byId[r.other.id]; if (t) { selectNode(t); if (state.view === "3d") focus3D(t); } });
      ol.appendChild(li);
    });
  }

  // ============================ フィルタUI（Legislative Explorer輸入） ============================
  var ERA_ORDER = ["明治", "大正", "昭和", "平成", "令和"];
  function buildFilters() {
    // 法段階チップ
    var ftypes = document.getElementById("f-types"); ftypes.innerHTML = "";
    var present = LEGEND_ORDER.filter(function (t) { return ALL.nodes.some(function (n) { return n.type === t; }); });
    present.forEach(function (t) {
      var c = document.createElement("span"); c.className = "chip"; c.setAttribute("data-type", t);
      c.innerHTML = '<i style="background:' + (COLORS[t] || "#9aa7bd") + '"></i>' + t;
      c.addEventListener("click", function () {
        state.types[t] = (state.types[t] === false); // toggle（未定義/true → false、false → true）
        c.classList.toggle("off", state.types[t] === false);
        onFilterChange();
      });
      ftypes.appendChild(c);
    });
    // 年代（元号）チップ（A層のみ）
    var feras = document.getElementById("f-eras"); feras.innerHTML = "";
    var eraPresent = ERA_ORDER.filter(function (e) { return ALL.nodes.some(function (n) { return n.layer === "A" && n.era === e; }); });
    eraPresent.forEach(function (e) {
      var c = document.createElement("span"); c.className = "chip"; c.setAttribute("data-era", e);
      c.innerHTML = e;
      c.addEventListener("click", function () {
        state.eras[e] = (state.eras[e] === false);
        c.classList.toggle("off", state.eras[e] === false);
        onFilterChange();
      });
      feras.appendChild(c);
    });
    // B層表示 ON/OFF
    var bchk = document.getElementById("f-blayer");
    bchk.checked = state.showBLayer;
    bchk.addEventListener("change", function () {
      state.showBLayer = bchk.checked;
      if (bchk.checked && state.layer === "A") { setLayerButtons("AB"); }
      onFilterChange();
    });
    // エッジ種別 凡例（クリックでトグル）
    var eleg = document.getElementById("edge-legend"); eleg.innerHTML = "";
    var kindsPresent = [];
    ALL.links.forEach(function (l) { if (kindsPresent.indexOf(l.kind) < 0) kindsPresent.push(l.kind); });
    var EDGE_ORDER = ["a-ref", "nin", "koushou", "yakuwari", "unyo", "enkaku", "bridge"];
    EDGE_ORDER.filter(function (k) { return kindsPresent.indexOf(k) >= 0; }).forEach(function (k) {
      var e = EDGE[k]; if (!e) return;
      var c = document.createElement("span"); c.className = "chip edge"; c.setAttribute("data-kind", k);
      c.innerHTML = '<i style="background:' + e.color + '"></i>' + e.label;
      if (state.edgeKinds[k] === false) c.classList.add("off"); // 既定OFFの種別を初期表示から反映
      c.addEventListener("click", function () {
        state.edgeKinds[k] = (state.edgeKinds[k] === false);
        c.classList.toggle("off", state.edgeKinds[k] === false);
        onFilterChange();
      });
      eleg.appendChild(c);
    });
  }
  function onFilterChange() { activeQ = null; selected = null; closePanel(); renderActive(); }
  function resetFilters() {
    state.types = {}; state.eras = {}; state.edgeKinds = {}; state.showBLayer = true;
    document.querySelectorAll("#f-types .chip, #f-eras .chip, #edge-legend .chip").forEach(function (c) { c.classList.remove("off"); });
    document.getElementById("f-blayer").checked = true;
    if (state.layer === "A") setLayerButtons("AB");
    onFilterChange();
  }
  function setLayerButtons(layer) {
    state.layer = layer;
    document.querySelectorAll("#f-layer .layer-chip").forEach(function (x) { x.classList.toggle("on", x.getAttribute("data-layer") === layer); });
    var b = document.getElementById("f-blayer"); if (b) b.checked = (layer !== "A") && state.showBLayer;
  }
  // state.edgeKinds と凡例チップのDOM表示状態を同期させてエッジ種別を1件ONにする。
  function enableEdgeKind(k) {
    state.edgeKinds[k] = true;
    var c = document.querySelector('#edge-legend .chip[data-kind="' + k + '"]');
    if (c) c.classList.remove("off");
  }

  function refresh3D() { if (!g3d) return; g3d.nodeColor(g3d.nodeColor()).linkColor(g3d.linkColor()); }

  // ============================ 検証API ============================
  function count2d() { return document.querySelectorAll("#graph g.node circle").length; }
  function count3d() { return g3d ? g3d.graphData().nodes.length : 0; }
})();
