"""2ホップ展開 + グラフ生成（法令星図データパイプライン M3）

処理（spec §1 拡張）:
  1. シード13法令の本則から参照される法令を発見（法令番号の丸括弧＝promulgation
     numberを anchor に identity を確定）→ 取得・キャッシュ（= 1ホップ目）。
  2. 1ホップ目の法令の本則から更に参照される法令を発見・取得（= 2ホップ目）。
     2ホップ目の法令は node には加えるが、そこからの新規展開はしない。
  3. 全 node 集合内で参照エッジを数える（weight = 参照回数）。
  4. **上限150法令**。超過分は参照頻度（被参照＝weighted in-degree）の低い順に足切り
     （Fowler 輸入・シードは常に保護）。dangling link を除去。
  5. data/output/graph.json を書き出す:
       nodes[{id,name,type(法律/政令/府省令…),era(制定年代=元号),nrefs}]
       links[{source,target,weight}]

重要な設計判断:
  - **本則（MainProvision）のみを対象**にする。附則（SupplProvision）は過去の一括改正法
    の施行期日・経過措置に付随した歴史的言及で、v1スコープ（現行法令の参照ネットワーク）
    外。M2精度ゲートの「附則混入53%」発見への対応＝推奨案1。
    これを 2ホップ展開に適用しないと、改正法名（○○の一部を改正する法律）が大量に
    node化して星図が汚染される。
  - identity は法令番号（law_num）で確定し、正式名称・種別・年代は API 応答から取得する
    （名称の正規表現パースに依存しない＝誤名寄せを避ける）。

APIキー不要。呼び出し間隔は egov._throttle（1.5秒）を共有。再実行可能（キャッシュ＋
resolve キャッシュで API 再呼び出しを最小化）。
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline import egov  # noqa: E402  BASE / CACHE_DIR / _throttle / get_law_xml
# S-1: 本則限定抽出・誤爆ガードは extract.py に一本化（二重実装しない）
from pipeline.extract import collect_main_text, match_kind  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "cache"
OUTPUT_DIR = ROOT / "data" / "output"
RESOLVE_CACHE = CACHE_DIR / "_resolve_cache.json"  # law_num -> meta or null（未解決）

MAX_NODES = 150          # spec §1 上限
DISCOVERY_CAP = 200      # 安全弁：発見 node がこれを超えたら新規発見を止める（足切り前の余裕・API予算）

# シード13法令（M1で確定した law_id）
SEED_IDS = [
    "325AC0000000201",  # 建築基準法
    "325CO0000000338",  # 建築基準法施行令
    "343AC0000000100",  # 都市計画法
    "336AC0000000191",  # 宅地造成及び特定盛土等規制法
    "344AC0000000057",  # 急傾斜地の崩壊による災害の防止に関する法律
    "412AC0000000057",  # 土砂災害警戒区域等における土砂災害防止対策の推進に関する法律
    "336AC0000000223",  # 災害対策基本法
    "410AC0100000066",  # 被災者生活再建支援法
    "341AC0000000073",  # 地震保険に関する法律
    "129AC0000000089",  # 民法
    "327AC1000000176",  # 宅地建物取引業法
    "323AC1000000186",  # 消防法
    "322AC0000000067",  # 地方自治法
]

# law_type（API enum）→ 日本語ラベル
TYPE_JA = {
    "Constitution": "憲法",
    "Act": "法律",
    "CabinetOrder": "政令",
    "ImperialOrder": "勅令",
    "MinisterialOrdinance": "府省令",
    "Rule": "規則",
    "Misc": "その他",
}
# law_num_era（API enum）→ 元号
ERA_JA = {
    "Meiji": "明治",
    "Taisho": "大正",
    "Showa": "昭和",
    "Heisei": "平成",
    "Reiwa": "令和",
}

# 本文中の法令番号（promulgation number）: <元号><年>年<種別>第<番号>号
LAWNUM_RE = re.compile(
    r"(?:明治|大正|昭和|平成|令和)[元一二三四五六七八九十百]+年[^、。（）()\s第]{1,15}第[一二三四五六七八九十百千]+号"
)


def _ln(el) -> str:
    return el.tag.split("}")[-1] if isinstance(el.tag, str) else "?"


# --- 本則テキスト抽出は extract.collect_main_text に一本化（S-1） -------------


def parse_law(xml_text: str) -> dict:
    """law_data_response XML から node メタ＋本則テキストを取り出す。"""
    root = ET.fromstring(xml_text)
    info = {}
    for e in root.iter():
        if _ln(e) == "law_info":
            for ch in e:
                info[_ln(ch)] = (ch.text or "").strip()
            break
    title = None
    for e in root.iter():
        if _ln(e) == "LawTitle":
            title = "".join(e.itertext()).strip()
            break
    main_text = collect_main_text(root)
    return {
        "law_id": info.get("law_id"),
        "title": title,
        "law_type": info.get("law_type"),
        "era": ERA_JA.get(info.get("law_num_era", ""), info.get("law_num_era", "")),
        "year": info.get("law_num_year"),
        "law_num": info.get("law_num"),
        "main_text": main_text,
    }


# --- resolve キャッシュ -----------------------------------------------------

def _load_resolve_cache() -> dict:
    if RESOLVE_CACHE.exists():
        return json.loads(RESOLVE_CACHE.read_text(encoding="utf-8"))
    return {}


def _save_resolve_cache(cache: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    RESOLVE_CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")


_STATS = Counter()  # api 呼び出し等の実測カウンタ


def resolve_num(law_num: str, cache: dict) -> dict | None:
    """法令番号 → 法令メタ {law_id,title,law_type} を /laws?law_num= で確定。

    未解決（0件 or 複数件で確定不能）は None を返し、cache に記録して再問い合わせしない。
    """
    if law_num in cache:
        _STATS["resolve_cache_hit"] += 1
        return cache[law_num]
    egov._throttle()
    _STATS["api_resolve"] += 1
    try:
        r = requests.get(
            f"{egov.BASE}/laws",
            params={"law_num": law_num, "response_format": "json", "limit": 5},
            timeout=egov.TIMEOUT,
        )
        r.raise_for_status()
        laws = r.json().get("laws", [])
    except Exception as e:  # noqa: BLE001
        _STATS["resolve_error"] += 1
        cache[law_num] = None
        return None
    if len(laws) != 1:
        # 0件（版違い・略記で不一致）または複数（確定不能）はスキップ
        cache[law_num] = None
        _STATS["resolve_ambiguous" if len(laws) > 1 else "resolve_miss"] += 1
        return None
    li = laws[0].get("law_info", {}) or {}
    ri = laws[0].get("revision_info", {}) or {}
    meta = {
        "law_id": li.get("law_id"),
        "title": ri.get("law_title"),
        "law_type": li.get("law_type"),
        "era": ERA_JA.get(li.get("law_num_era", ""), li.get("law_num_era", "")),
        "year": li.get("law_num_year"),
        "law_num": li.get("law_num"),
    }
    cache[law_num] = meta
    return meta


# --- BFS 2ホップ展開 --------------------------------------------------------

def main_text_of(law_id: str) -> str:
    xml_text = egov.get_law_xml(law_id)  # キャッシュ済みならネット不使用
    return parse_law(xml_text)["main_text"]


def build() -> dict:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    resolve_cache = _load_resolve_cache()

    # nodes: law_id -> meta（title/type/era/year/main_text）
    nodes: dict[str, dict] = {}
    level: dict[str, int] = {}
    # 発見時被参照度＝シード拡張（level0+level1本則）が各法令を参照した distinct 元法令数。
    # これが「シードから参照された頻度」＝足切り基準（Fowler中心性の seed-personalized 版）。
    # 全ペア相互引用（会社法⇄金商法等の稠密クリーク）にドメインが乗っ取られるのを防ぐ。
    disc_ref: Counter = Counter()

    # シード投入（キャッシュから）
    for lid in SEED_IDS:
        meta = parse_law(egov.get_law_xml(lid))
        nodes[lid] = meta
        level[lid] = 0

    # BFS 深さ2（level0→1, level1→2）
    frontier = list(SEED_IDS)
    for hop in (1, 2):
        next_frontier: list[str] = []
        for lid in frontier:
            text = nodes[lid]["main_text"]
            seen_nums = set()
            for m in LAWNUM_RE.finditer(text):
                num = m.group(0)
                if num in seen_nums:
                    continue
                seen_nums.add(num)
                if len(nodes) >= DISCOVERY_CAP:
                    _STATS["discovery_capped"] += 1
                    break
                meta = resolve_num(num, resolve_cache)
                if not meta or not meta.get("law_id"):
                    continue
                tid = meta["law_id"]
                if tid == lid:
                    continue  # 自己参照は発見度に数えない
                disc_ref[tid] += 1  # 「シードから参照された」頻度（既知 node への参照も計上）
                if tid in nodes:
                    continue  # 既知 node（本文取得済み）
                # 新規 node：本文取得（キャッシュ）
                was_cached = (CACHE_DIR / f"{tid}.xml").exists()
                try:
                    xml_text = egov.get_law_xml(tid)  # 未キャッシュなら fetch
                    if not was_cached:
                        _STATS["api_lawdata"] += 1
                except Exception:  # noqa: BLE001
                    _STATS["fetch_error"] += 1
                    continue
                full = parse_law(xml_text)
                # メタは resolve 応答を優先（title は revision_info 由来で確実）
                full["title"] = meta.get("title") or full.get("title")
                full["law_type"] = meta.get("law_type") or full.get("law_type")
                full["era"] = meta.get("era") or full.get("era")
                nodes[tid] = full
                level[tid] = hop
                next_frontier.append(tid)
                if len(nodes) % 20 == 0:
                    print(f"  [hop{hop}] nodes={len(nodes)} resolves={_STATS['api_resolve']} fetches={_STATS['api_lawdata']}", file=sys.stderr, flush=True)
            if len(nodes) >= DISCOVERY_CAP:
                break
        _STATS[f"level{hop}_new"] = len(next_frontier)
        _save_resolve_cache(resolve_cache)
        frontier = next_frontier

    _save_resolve_cache(resolve_cache)

    # --- エッジ計数（本則のみ・最長一致＋誤爆ガード2種：extract.py と同方針） ---
    titles = {nodes[i]["title"]: i for i in nodes if nodes[i].get("title")}
    ordered = sorted(titles, key=len, reverse=True)
    matcher = re.compile("|".join(re.escape(t) for t in ordered))

    edge_w: dict[tuple[str, str], int] = defaultdict(int)  # (from_id,to_id)->count
    self_ref = 0
    skip_guard = skip_amend = 0
    for lid, meta in nodes.items():
        text = meta["main_text"]
        from_title = meta.get("title")
        for m in matcher.finditer(text):
            to_title = m.group(0)
            kind = match_kind(text, m)  # 誤爆ガードは extract.match_kind に一本化（S-1）
            if kind == "guard":  # 辞書外の施行令/規則の頭を拾った
                skip_guard += 1
                continue
            if kind == "amend":  # 改正法名の頭
                skip_amend += 1
                continue
            tid = titles.get(to_title)
            if tid is None:
                continue
            if tid == lid or to_title == from_title:
                self_ref += 1
                continue
            edge_w[(lid, tid)] += 1

    # --- 被参照 in-degree 計算関数 ---
    def in_degree(edges: dict[tuple[str, str], int]) -> Counter:
        """weighted（参照回数の総和）。tie-break 用。"""
        c: Counter = Counter()
        for (s, t), w in edges.items():
            c[t] += w
        return c

    def distinct_in_degree(edges: dict[tuple[str, str], int]) -> Counter:
        """distinct-referencer（それを参照する distinct 法令数＝breadth 中心性）。
        nrefs はこちらを採用：会社法⇄金商法⇄税法のような稠密相互引用（1法令が数百回
        引用）に乗っ取られず、「どれだけ広く参照されるか」を表す（実測で weighted は
        会社法1473で建築基準法170を圧倒し星図が歪む）。"""
        c: Counter = Counter()
        for (s, t) in edges:
            c[t] += 1
        return c

    # --- 足切り（>150：非シードを「シードからの被参照頻度」の低い順に除去・シード保護） ---
    # 基準＝disc_ref（seed拡張が参照した distinct 元法令数）。全ペア in-degree ではなく
    # これを使う理由：後者だと会社法⇄金商法⇄税法の稠密クリークが乗っ取り、建築・災害の
    # 中核が足切りされる（実測で確認）。disc_ref はドメイン近接度。
    cut_ids: list[str] = []
    if len(nodes) > MAX_NODES:
        indeg = in_degree(edge_w)  # tie-break 用（全ペア被参照＝weight合計）
        non_seed = [i for i in nodes if level[i] != 0]
        # 昇順の足切り順位（level中立化）：
        #   disc_ref（シード被参照） → indeg（weight合計） → 法令ID辞書順
        # level を tie-break から除外。従来 -level[i] を挟んでいたため level2 が同点時に
        # 常に level1 より先に切られ「2ホップ拡張」が構造的に空文化していた。
        # 中立化後は 2ホップは上限であって生存保証ではない（残るかは disc_ref/indeg 次第）。
        non_seed.sort(key=lambda i: (disc_ref[i], indeg[i], i))
        n_remove = len(nodes) - MAX_NODES
        cut_ids = non_seed[:n_remove]
    cut_set = set(cut_ids)
    for i in cut_ids:
        del nodes[i]

    # M-1: 足切り後の最終ノードの level 内訳（正直に記録＝2ホップの生存実数）
    survivor_level_dist = Counter(level[i] for i in nodes)
    cut_level_dist = Counter(level[i] for i in cut_ids)

    # dangling link 除去（端点が足切りされたエッジ）
    kept_edges = {k: w for k, w in edge_w.items() if k[0] not in cut_set and k[1] not in cut_set}

    # 最終 nrefs（distinct-referencer）は残ったエッジから再計算（出力整合）
    final_indeg = distinct_in_degree(kept_edges)
    final_windeg = in_degree(kept_edges)  # 参照回数総和（参考・_meta 用）
    max_wid = max(final_windeg.values()) if final_windeg else 0

    node_records = []
    for lid, meta in nodes.items():
        node_records.append({
            "id": lid,
            "name": meta.get("title"),
            "type": TYPE_JA.get(meta.get("law_type"), meta.get("law_type") or "不明"),
            "era": meta.get("era") or "不明",
            "nrefs": int(final_indeg.get(lid, 0)),
        })
    node_records.sort(key=lambda r: r["nrefs"], reverse=True)

    link_records = [
        {"source": s, "target": t, "weight": w}
        for (s, t), w in sorted(kept_edges.items(), key=lambda kv: kv[1], reverse=True)
    ]

    # --- 整合性チェック：dangling link = 0 ---
    idset = {r["id"] for r in node_records}
    dangling = [l for l in link_records if l["source"] not in idset or l["target"] not in idset]

    result = {
        "nodes": node_records,
        "links": link_records,
        "_meta": {
            "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
            "seed_count": len(SEED_IDS),
            "level1_new": _STATS.get("level1_new", 0),
            "level2_new": _STATS.get("level2_new", 0),
            "discovered_total": len(idset),
            "node_count": len(node_records),
            "edge_count": len(link_records),
            "cut_count": len(cut_ids),
            "level_dist_final": {f"level{k}": v for k, v in sorted(survivor_level_dist.items())},
            "level_dist_cut": {f"level{k}": v for k, v in sorted(cut_level_dist.items())},
            "dangling": len(dangling),
            "nrefs_metric": "distinct_referencer_in_degree",
            "link_weight_metric": "citation_occurrences",
            "max_link_weight": max((l["weight"] for l in link_records), default=0),
            "max_weighted_in_degree": int(max_wid),
            "type_dist": dict(Counter(r["type"] for r in node_records)),
            "era_dist": dict(Counter(r["era"] for r in node_records)),
            "self_ref_skipped": self_ref,
            "skip_guard": skip_guard,
            "skip_amend": skip_amend,
            "provision_scope": "MainProvision_only",
            "api_resolve_calls": _STATS.get("api_resolve", 0),
            "resolve_cache_hit": _STATS.get("resolve_cache_hit", 0),
            "resolve_miss": _STATS.get("resolve_miss", 0),
            "resolve_ambiguous": _STATS.get("resolve_ambiguous", 0),
            "discovery_capped": _STATS.get("discovery_capped", 0),
        },
    }
    return result, dangling, cut_ids


def main() -> int:
    result, dangling, cut_ids = build()
    out_path = OUTPUT_DIR / "graph.json"
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    m = result["_meta"]
    print("=== M3 グラフ生成 実測 ===")
    print(f"シード                : {m['seed_count']}")
    print(f"1ホップ目 新規発見    : {m['level1_new']}")
    print(f"2ホップ目 新規発見    : {m['level2_new']}")
    print(f"発見 node 合計(足切前): {m['discovered_total'] + m['cut_count']}")
    print(f"足切り件数            : {m['cut_count']}")
    print(f"最終 node 数          : {m['node_count']}")
    print(f"最終 level 内訳        : {m['level_dist_final']}（2ホップは上限＝生存保証でない）")
    print(f"足切り level 内訳      : {m['level_dist_cut']}")
    print(f"最終 edge 数          : {m['edge_count']}")
    print(f"dangling link         : {m['dangling']}  (=0 で整合)")
    print(f"本則限定              : {m['provision_scope']}")
    print(f"自己参照スキップ      : {m['self_ref_skipped']}")
    print(f"施行ガード/改正ガード : {m['skip_guard']} / {m['skip_amend']}")
    print(f"API resolve 呼出      : {m['api_resolve_calls']}（cache hit {m['resolve_cache_hit']}）")
    print(f"resolve 失敗/曖昧     : {m['resolve_miss']} / {m['resolve_ambiguous']}")
    print(f"discovery cap 到達    : {m['discovery_capped']}")
    print(f"出力: {out_path}")

    print("\n=== 被参照トップ15 node ===")
    for r in result["nodes"][:15]:
        print(f"  {r['nrefs']:>4}  {r['type']:<4} {r['era']:<3} {r['name']}")

    if dangling:
        print(f"\n[NG] dangling link {len(dangling)} 件検出", file=sys.stderr)
        return 1
    print("\n[OK] dangling link = 0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
