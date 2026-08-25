"""Failure fixture: candidate does not improve the baseline metric."""

from __future__ import annotations

import argparse
import json

parser = argparse.ArgumentParser()
parser.add_argument("--mode", choices=("baseline", "candidate"), required=True)
args = parser.parse_args()
print(json.dumps({"accuracy": 0.75, "mode": args.mode, "seed": 7}))
