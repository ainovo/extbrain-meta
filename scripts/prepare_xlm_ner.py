#!/usr/bin/env python3
"""One-time assembly of a transformers.js-ready XLM-RoBERTa NER model dir.

Base model: Davlan/xlm-roberta-base-ner-hrl (XLM-R base fine-tuned for NER,
BIO labels incl. DATE). That repo ships only PyTorch/safetensors weights,
so this script fetches the pre-exported ONNX port
tjruesch/xlm-roberta-base-ner-hrl-onnx (same config + Unigram tokenizer,
FP32 + dynamically-quantized INT8 ONNX) into
models/xlm-roberta-base-ner-hrl/.

Re-runnable: finished files are skipped by exact remote size. ~1.4GB total
(1.1GB FP32 + 265MB INT8); pass --no-fp32 to fetch the quantized weights
only (the server prefers them and only falls back to FP32).
Requires: python3, network.
"""

import os
import sys
import urllib.request

PORT_REPO = "tjruesch/xlm-roberta-base-ner-hrl-onnx"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, "models", "xlm-roberta-base-ner-hrl")

FILES_REQUIRED = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "sentencepiece.bpe.model",
    "onnx/model_quantized.onnx",
]
FILES_OPTIONAL = [
    "onnx/model.onnx",
]


def remote_size(url):
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            n = r.getheader("Content-Length")
            return int(n) if n else -1
    except Exception:
        return -1


def fetch(repo, name, dest, required=True):
    url = f"https://huggingface.co/{repo}/resolve/main/{name}"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    want = remote_size(url)
    if want > 0 and os.path.exists(dest) and os.path.getsize(dest) == want:
        print(f"[ner] cached {name} ({want / 1e6:.0f}MB)")
        return dest
    if want < 0 and required:
        sys.exit(f"error: could not stat {url}")
    if want < 0:
        print(f"[ner] WARNING: skipping {name} (unreachable)")
        return None
    print(f"[ner] downloading {name} ({want / 1e6:.0f}MB)...", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "extbrain-meta"})
    got = 0
    last_mark = 0
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(4 * 1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if got - last_mark >= 200 * 1024 * 1024:
                print(f"      ...{got / 1e6:.0f}MB", flush=True)
                last_mark = got
    if got != want:
        os.remove(dest)
        sys.exit(f"error: short download for {name} ({got} != {want} bytes)")
    print(f"[ner] saved {name} ({got / 1e6:.0f}MB)")
    return dest


def main():
    only_quant = "--no-fp32" in sys.argv[1:]
    for name in FILES_REQUIRED:
        fetch(PORT_REPO, name, os.path.join(DEST, name), required=True)
    if only_quant:
        print("[ner] --no-fp32: skipping full-precision weights")
    else:
        for name in FILES_OPTIONAL:
            fetch(PORT_REPO, name, os.path.join(DEST, name), required=False)
    total = sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _, fns in os.walk(DEST)
        for f in fns
    )
    print(f"[ner] done: {DEST} ({total / 1e9:.2f}GB). Restart the dev server.")


if __name__ == "__main__":
    main()
