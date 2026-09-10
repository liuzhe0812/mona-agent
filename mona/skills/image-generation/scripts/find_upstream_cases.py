"""Find relevant vendored awesome-gpt-image-2 cases without loading all prompts."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def terms(value: str) -> set[str]:
    normalized = value.casefold()
    words = set(re.findall(r"[a-z0-9][a-z0-9_-]+", normalized))
    cjk = "".join(re.findall(r"[\u3400-\u9fff]", normalized))
    words.update(cjk[index : index + 2] for index in range(max(0, len(cjk) - 1)))
    if len(cjk) == 1:
        words.add(cjk)
    return {term for term in words if term}


def case_text(case: dict[str, Any], field: str) -> str:
    value = case.get(field, "")
    if isinstance(value, list):
        return " ".join(str(item) for item in value)
    return str(value)


def score(case: dict[str, Any], query_terms: set[str]) -> int:
    fields = (
        ("title", 8),
        ("category", 6),
        ("styles", 5),
        ("scenes", 5),
        ("promptPreview", 2),
        ("prompt", 1),
    )
    total = 0
    for field, weight in fields:
        text = case_text(case, field).casefold()
        total += sum(weight for term in query_terms if term in text)
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description="Search vendored image-prompt cases")
    parser.add_argument("query")
    parser.add_argument("--category", default="")
    parser.add_argument("--limit", type=int, default=3, choices=range(1, 6))
    args = parser.parse_args()

    case_file = Path(__file__).parents[1] / "references/upstream/cases.json"
    document = json.loads(case_file.read_text(encoding="utf-8"))
    candidates = document.get("cases", [])
    if args.category:
        needle = args.category.casefold()
        candidates = [case for case in candidates if needle in case_text(case, "category").casefold()]
    query_terms = terms(args.query)
    ranked = sorted(
        ((score(case, query_terms), case) for case in candidates),
        key=lambda item: (item[0], bool(item[1].get("featured")), item[1].get("id", 0)),
        reverse=True,
    )
    results = []
    for relevance, case in ranked[: args.limit]:
        if relevance <= 0:
            break
        results.append(
            {
                "id": case.get("id"),
                "title": case.get("title"),
                "category": case.get("category"),
                "styles": case.get("styles", []),
                "scenes": case.get("scenes", []),
                "prompt": case.get("prompt", ""),
                "source_label": case.get("sourceLabel", ""),
                "source_url": case.get("sourceUrl", ""),
                "gallery_url": case.get("githubUrl", ""),
                "relevance": relevance,
            }
        )
    print(json.dumps({"query": args.query, "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
