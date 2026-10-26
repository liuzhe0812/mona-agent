"""Deterministic position schedule for the native runner contract fixture."""

import pandas as pd


class SignalEngine:
    def generate(self, data_map):
        signals = {}
        for symbol, bars in data_map.items():
            weights = pd.Series(0.0, index=bars.index)
            if len(weights) > 3:
                weights.iloc[1:3] = 0.5
            signals[symbol] = weights
        return signals
