"""Tiny deterministic algorithm fixture; no external dependencies."""

from __future__ import annotations

import argparse
import json


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("baseline", "candidate"), required=True)
    args = parser.parse_args()
    accuracy = 0.75 if args.mode == "baseline" else 0.875
    print(json.dumps({"accuracy": accuracy, "seed": 7, "mode": args.mode}))


if __name__ == "__main__":
    main()
