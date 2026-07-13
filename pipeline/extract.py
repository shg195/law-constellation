"""参照抽出器（法令星図データパイプライン M2）

入力  : data/cache/*.xml（M1でキャッシュ済みの法令標準XML）
出力  : data/output/references_raw.json
        [{"from_law", "to_law_name", "count", "例文抜粋":[...]}, ...]

方針（spec §2・v1）:
  - 抽出対象は **本則（MainProvision）配下の Article のみ**。附則（SupplProvision）は
    過去の一括改正法の施行期日・経過措置に付随した歴史的言及で、現行法令の参照
    ネットワーク（v1スコープ）外（M2精度ゲートで附則混入53%を確認）。
  - 抽出対象は **明示的な法令名の引用のみ**。
  - 法令名辞書 = 取得済み法令（シード13）の正式名称（LawTitle）から構築。
    to_law_name は辞書内の法令に限定する（＝星図のノード集合内エッジ）。
  - 部分一致の誤爆（「建築基準法施行令」を「建築基準法」に数える等）を防ぐため
    **最長一致**で判定（辞書を長い順に並べた正規表現の交替で先頭一致＝最長一致）。
  - 辞書外の長い法令名（例「建築基準法施行規則」＝辞書になし）への誤爆を防ぐため、
    直後が「施行」で続く一致はスキップ（より長い別法令の頭を拾っている）。
  - 「同法」「この法律」等の照応・略称の解決は **やらない**。
    スキップ件数だけ数えて正直に記録する（v2課題）。
  - 自己参照（from == to）はエッジに数えず別途カウント。
"""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data" / "output"

# 照応・略称パターン（v1では解決しない＝スキップして件数のみ記録）
ANAPHORA_PATTERNS = [
    "この法律",
    "同法",
    "同令",
    "本法",
    "当該法律",
    "その法律",
    "この政令",
    "同政令",
]


def _localname(tag) -> str:
    """名前空間を除いたローカル名。コメント等の非文字列 tag も安全に扱う。"""
    return tag.split("}")[-1] if isinstance(tag, str) else "?"


def _collect_main(el, in_main: bool, in_suppl: bool, out: list) -> None:
    """MainProvision 配下（かつ SupplProvision 配下でない）Article のテキストを集める。"""
    name = _localname(el.tag)
    in_main = in_main or name == "MainProvision"
    in_suppl = in_suppl or name == "SupplProvision"
    if name == "Article" and in_main and not in_suppl:
        out.append("".join(el.itertext()))
        return  # Article 内は itertext で全部取ったので下降不要
    for ch in el:
        _collect_main(ch, in_main, in_suppl, out)


def collect_main_text(root) -> str:
    """XML root から本則（MainProvision）配下 Article のテキストを連結・正規化して返す。

    S-1: 本則限定抽出はこの1関数に一本化し、build_graph.py もこれを import して使う
    （附則混入の除去ロジックを二重実装しない）。
    """
    parts: list[str] = []
    _collect_main(root, False, False, parts)
    return re.sub(r"\s+", "", "".join(parts))  # 空白・改行を除去


def match_kind(text: str, m: re.Match) -> str:
    """法令名一致 m を分類して返す（誤爆ガードの一本化・build_graph.py と共有）。

      "guard" … 直後が「施行」＝辞書外の施行令/施行規則等の頭を拾った誤爆
      "amend" … 直後40字以内に「第」より先に「の一部を改正する」＝改正法名の頭を拾った誤爆
      "ref"   … 有効な明示的法令名引用
    """
    end = m.end()
    if text[end : end + 2] == "施行":
        return "guard"
    win = text[end : end + 40]
    p = win.find("の一部を改正する")
    q = win.find("第")
    if p != -1 and (q == -1 or p < q):
        return "amend"
    return "ref"


def load_laws() -> list[dict]:
    """キャッシュ済みXMLを読み、各法令の {law_id, title, text} を返す。

    title = LawTitle テキスト・text = **本則（MainProvision）配下** Article を連結したもの。
    """
    laws: list[dict] = []
    for path in sorted(CACHE_DIR.glob("*.xml")):
        xml = path.read_text(encoding="utf-8")
        root = ET.fromstring(xml)
        title = None
        for el in root.iter():
            if _localname(el.tag) == "LawTitle":
                title = "".join(el.itertext()).strip()
                break
        if not title:
            continue
        text = collect_main_text(root)
        laws.append({"law_id": path.stem, "title": title, "text": text})
    return laws


def build_matcher(titles: list[str]) -> re.Pattern:
    """辞書の法令名を長い順に並べた交替正規表現を返す（最長一致用）。"""
    ordered = sorted(set(titles), key=len, reverse=True)
    alt = "|".join(re.escape(t) for t in ordered)
    return re.compile(alt)


def _snippet(text: str, start: int, end: int, span: int = 18) -> str:
    """一致箇所の前後を含む例文抜粋を返す。"""
    lo = max(0, start - span)
    hi = min(len(text), end + span)
    s = text[lo:hi]
    if lo > 0:
        s = "…" + s
    if hi < len(text):
        s = s + "…"
    return s


def extract() -> dict:
    """全法令から参照を抽出し、結果とスキップ統計を返す。"""
    laws = load_laws()
    titles = [l["title"] for l in laws]
    matcher = build_matcher(titles)
    title_set = set(titles)

    # (from_title, to_title) -> {count, examples}
    edges: dict[tuple[str, str], dict] = defaultdict(
        lambda: {"count": 0, "examples": []}
    )
    self_refs: Counter = Counter()
    skip_guard = 0  # 「施行」で続く辞書外法令への誤爆をスキップした数
    skip_amend = 0  # 「…の一部を改正する法律」等・改正法名の頭を拾った誤爆をスキップした数
    skip_anaphora: Counter = Counter()

    for law in laws:
        from_title = law["title"]
        text = law["text"]

        # 照応・略称のスキップ計数
        for pat in ANAPHORA_PATTERNS:
            n = text.count(pat)
            if n:
                skip_anaphora[pat] += n

        # 明示的法令名の抽出（最長一致・誤爆ガードは match_kind に一本化）
        for m in matcher.finditer(text):
            to_title = m.group(0)
            kind = match_kind(text, m)
            if kind == "guard":
                skip_guard += 1
                continue
            if kind == "amend":
                skip_amend += 1
                continue
            if to_title == from_title:
                self_refs[from_title] += 1
                continue
            if to_title not in title_set:
                continue
            e = edges[(from_title, to_title)]
            e["count"] += 1
            if len(e["examples"]) < 3:
                e["examples"].append(_snippet(text, m.start(), m.end()))

    return {
        "edges": edges,
        "self_refs": self_refs,
        "skip_guard": skip_guard,
        "skip_amend": skip_amend,
        "skip_anaphora": skip_anaphora,
        "law_count": len(laws),
    }


def to_records(edges: dict[tuple[str, str], dict]) -> list[dict]:
    """エッジ辞書を出力レコード配列（count降順）に変換。"""
    records = []
    for (frm, to), v in edges.items():
        records.append(
            {
                "from_law": frm,
                "to_law_name": to,
                "count": v["count"],
                "例文抜粋": v["examples"],
            }
        )
    records.sort(key=lambda r: r["count"], reverse=True)
    return records


def main() -> None:
    result = extract()
    records = to_records(result["edges"])

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / "references_raw.json"
    out_path.write_text(
        json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    total_refs = sum(r["count"] for r in records)
    total_self = sum(result["self_refs"].values())
    total_anaphora = sum(result["skip_anaphora"].values())

    print(f"対象法令数            : {result['law_count']}")
    print(f"抽出エッジ（法令ペア）: {len(records)}")
    print(f"抽出参照 総数         : {total_refs}")
    print(f"自己参照（除外）      : {total_self}")
    print(f"スキップ:施行ガード誤爆: {result['skip_guard']}")
    print(f"スキップ:改正法名誤爆  : {result['skip_amend']}")
    print(f"スキップ:照応・略称   : {total_anaphora}")
    for pat, n in result["skip_anaphora"].most_common():
        print(f"    {pat:<8} {n}")
    print(f"出力: {out_path}")

    print("\n=== 参照回数トップ20（法令ペア） ===")
    print(f"{'#':>2}  {'count':>5}  from → to")
    print("-" * 78)
    for i, r in enumerate(records[:20], 1):
        print(f"{i:>2}  {r['count']:>5}  {r['from_law']} → {r['to_law_name']}")


if __name__ == "__main__":
    main()
