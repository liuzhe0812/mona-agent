"""Persistent offline CosyVoice worker, isolated from the interaction process.

The launcher supplies paths and style; this worker never downloads assets. It
emits framed little-endian signed PCM16 at 24 kHz to stdout. Killing the process stops
generation without interrupting the Mona task which produced the text.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import struct
import sys


def contained(root: Path, relative: str, *, directory: bool = False) -> Path:
    base = root.expanduser().resolve(strict=True)
    candidate = Path(relative)
    if candidate.is_absolute():
        raise ValueError("asset path must be relative to its trusted root")
    path = (base / candidate).resolve(strict=True)
    if not path.is_relative_to(base) or not (path.is_dir() if directory else path.is_file()):
        raise ValueError("asset is outside its trusted root or unavailable")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--matcha", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--reference-root", type=Path, required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--instruction", required=True)
    args = parser.parse_args()
    source = contained(args.runtime_root, args.source, directory=True)
    matcha = contained(args.runtime_root, args.matcha, directory=True)
    model = contained(args.runtime_root, args.model, directory=True)
    reference = contained(args.reference_root, args.reference)
    for name in ("cosyvoice3.yaml", "llm.pt", "flow.pt", "hift.pt", "campplus.onnx", "speech_tokenizer_v3.onnx"):
        contained(model, name)
    sys.path[:0] = [str(source), str(matcha)]
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    output = sys.stdout.buffer
    def frame(kind: bytes, request_id: str, payload: bytes = b"") -> None:
        data = kind + request_id.encode("ascii") + payload
        output.write(struct.pack(">I", len(data)))
        output.write(data)
        output.flush()

    # Upstream prints status to stdout; keep the PCM stream uncontaminated.
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import onnxruntime
        from cosyvoice.cli.cosyvoice import AutoModel

        session = onnxruntime.InferenceSession

        def cpu_session(*a, **kw):
            kw["providers"] = ["CPUExecutionProvider"]
            return session(*a, **kw)

        onnxruntime.InferenceSession = cpu_session
        try:
            engine = AutoModel(model_dir=str(model))
        finally:
            onnxruntime.InferenceSession = session
        if engine.sample_rate != 24000:
            raise ValueError("unexpected sample rate")
        frame(b"R", "0" * 32)
        for line in sys.stdin:
            if len(line) > 20000:
                raise ValueError("request too large")
            request = json.loads(line)
            request_id, text = request["id"], request["text"]
            if (not isinstance(request_id, str) or len(request_id) != 32
                    or any(c not in "0123456789abcdef" for c in request_id)
                    or not isinstance(text, str) or not text.strip() or len(text) > 4000):
                raise ValueError("invalid request")
            for part in engine.inference_instruct2(text, args.instruction, str(reference), stream=True):
                samples = part["tts_speech"].detach().cpu().numpy().reshape(-1)
                pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
                frame(b"D", request_id, pcm)
            frame(b"E", request_id)


if __name__ == "__main__":
    main()
