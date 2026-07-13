"""e-Gov 法令API v2 クライアント（法令星図データパイプライン M1）

エンドポイント（2026-07-11 OpenAPI仕様 lawapi-v2.yaml で実在確認）:
  BASE = https://laws.e-gov.go.jp/api/2
  GET /laws                                法令一覧取得（law_title 等で検索）
  GET /law_data/{law_id_or_num_or_revision_id}   法令本文取得（法令標準XML）

機能:
  1. search_law(title)  … 法令名 → 法令ID検索（部分一致・exact優先）
  2. get_law_xml(law_id) … 法令ID → 本文XML取得（data/cache/ にキャッシュ・再取得しない）
  3. extract_articles(xml_text) … XML → 条（Article）テキスト抽出

APIキー不要。呼び出し間隔を 1.5 秒空ける（礼儀）。
"""
from __future__ import annotations

import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional

import requests

BASE = "https://laws.e-gov.go.jp/api/2"
CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache"
REQUEST_INTERVAL = 1.5  # 秒・API呼び出し間隔
TIMEOUT = 60
_last_call = 0.0


def _localname(tag: str) -> str:
    """XML要素タグから名前空間を除いたローカル名を返す。"""
    return tag.split("}")[-1]


def _throttle() -> None:
    """直前のAPI呼び出しから REQUEST_INTERVAL 秒空ける。"""
    global _last_call
    wait = REQUEST_INTERVAL - (time.monotonic() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.monotonic()


# --- 1. 法令名 → 法令ID検索 ------------------------------------------------

def search_law(title: str, limit: int = 20) -> list[dict]:
    """法令名（部分一致）で検索し、候補リストを返す。

    返却: [{"law_id","law_title","law_num","law_type"}, ...]
    """
    _throttle()
    r = requests.get(
        f"{BASE}/laws",
        params={"law_title": title, "response_format": "json", "limit": limit},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    out: list[dict] = []
    for item in r.json().get("laws", []):
        info = item.get("law_info", {}) or {}
        rev = item.get("revision_info", {}) or {}
        out.append(
            {
                "law_id": info.get("law_id"),
                "law_title": rev.get("law_title"),
                "law_num": info.get("law_num"),
                "law_type": info.get("law_type"),
            }
        )
    return out


def find_law_id(title: str) -> Optional[dict]:
    """法令名に完全一致する法令を1件返す（無ければ None）。

    完全一致が複数のときは law_type=Act（法律）を優先、次に候補先頭。
    """
    cands = search_law(title)
    exact = [c for c in cands if c["law_title"] == title and c["law_id"]]
    if not exact:
        return None
    acts = [c for c in exact if c["law_type"] == "Act"]
    return (acts or exact)[0]


# --- 2. 法令ID → 本文XML取得（キャッシュ付き） ----------------------------

def get_law_xml(law_id: str, force: bool = False) -> str:
    """法令IDから本文XMLを取得。data/cache/<law_id>.xml にキャッシュ。

    キャッシュがあれば再取得しない（force=True で強制再取得）。
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{law_id}.xml"
    if cache_path.exists() and not force:
        return cache_path.read_text(encoding="utf-8")

    _throttle()
    r = requests.get(
        f"{BASE}/law_data/{law_id}",
        params={"response_format": "xml"},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    xml_text = r.text
    cache_path.write_text(xml_text, encoding="utf-8")
    return xml_text


# --- 3. XML → 条文テキスト抽出 --------------------------------------------

def extract_articles(xml_text: str) -> list[dict]:
    """法令標準XMLから条（Article）を抽出する。

    返却: [{"num","title","text"}, ...]
      num   … Article@Num 属性（例 "1", "6_2"）
      title … ArticleTitle テキスト（例 "第六条の二"）
      text  … 条内の全テキストを連結したもの
    """
    root = ET.fromstring(xml_text)
    articles: list[dict] = []
    for el in root.iter():
        if _localname(el.tag) != "Article":
            continue
        num = el.attrib.get("Num", "")
        title = ""
        for sub in el.iter():
            if _localname(sub.tag) == "ArticleTitle":
                title = "".join(sub.itertext()).strip()
                break
        text = "".join(el.itertext()).strip()
        articles.append({"num": num, "title": title, "text": text})
    return articles


def article_count(xml_text: str) -> int:
    """条（Article要素）の数を返す。"""
    return len(extract_articles(xml_text))


# --- 実測テスト（spec §1 シード13法令） -----------------------------------

SEED_LAWS = [
    "建築基準法",
    "建築基準法施行令",
    "都市計画法",
    "宅地造成及び特定盛土等規制法",
    "急傾斜地の崩壊による災害の防止に関する法律",
    "土砂災害警戒区域等における土砂災害防止対策の推進に関する法律",
    "災害対策基本法",
    "被災者生活再建支援法",
    "地震保険に関する法律",
    "民法",
    "宅地建物取引業法",
    "消防法",
    "地方自治法",
]


def _run_seed_test() -> int:
    """シード13法令を全件取得し、各法令の条数を出力。失敗数を返す。"""
    failures = 0
    print(f"{'法令名':<40} {'law_id':<18} {'条数':>5}  cache")
    print("-" * 78)
    for name in SEED_LAWS:
        try:
            hit = find_law_id(name)
            if not hit:
                print(f"{name:<40} {'NOT FOUND':<18} {'-':>5}  -")
                failures += 1
                continue
            law_id = hit["law_id"]
            cached = (CACHE_DIR / f"{law_id}.xml").exists()
            xml_text = get_law_xml(law_id)
            n = article_count(xml_text)
            print(f"{hit['law_title']:<40} {law_id:<18} {n:>5}  {'hit' if cached else 'new'}")
        except Exception as e:  # noqa: BLE001
            print(f"{name:<40} {'ERROR':<18} {'-':>5}  {type(e).__name__}: {e}")
            failures += 1
    return failures


if __name__ == "__main__":
    import sys

    fails = _run_seed_test()
    print("-" * 78)
    print(f"失敗: {fails} / {len(SEED_LAWS)}")
    sys.exit(1 if fails else 0)
