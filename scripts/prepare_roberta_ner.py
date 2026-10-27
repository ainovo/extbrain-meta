#!/usr/bin/env python3
"""One-time assembly of a transformers.js-ready RoBERTa-large NER model dir.

Jean-Baptiste/roberta-large-ner-english ships root-level model.onnx but no
tokenizer.json / onnx/ layout, so transformers.js cannot load it directly.
This script assembles models/roberta-large-ner-english/ from verified parts:

  - weights + config + vocab from the author repo (Jean-Baptiste),
  - tokenizer.json from a same-vocab port, verified two ways: the port's
    vocab/merges must hash-match the author's, and the vocab/merges embedded
    in tokenizer.json must equal the author's files,
  - dynamic int8 quantization (local onnxruntime) for CPU-speed q8 inference.

Re-runnable: finished files are skipped by exact remote size. ~1.8GB total.
Requires: python3, pip, network. Installs onnx + onnxruntime into the
project .venv (created if needed) for the quantization step only.
"""

import json
import os
import subprocess
import sys
import urllib.request

JB_REPO = "Jean-Baptiste/roberta-large-ner-english"
TOK_REPO = "satyamsaf3ai/roberta-large-ner-english-onnx"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, "models", "roberta-large-ner-english")
TMP = os.path.join(DEST, ".tmp-verify")


def ensure_quant_deps():
    """Re-exec under the project .venv with onnx+onnxruntime installed."""
    try:
        import onnx  # noqa: F401
        import onnxruntime  # noqa: F401
        return
    except ImportError:
        pass
    if os.environ.get("_NER_BOOTSTRAPPED") == "1":
        sys.exit("error: onnx/onnxruntime import still failing after bootstrap")
    venv = os.path.join(ROOT, ".venv")
    py = os.path.join(venv, "bin", "python")
    if not os.path.exists(py):
        print(f"[ner] creating project venv at {venv}")
        subprocess.check_call([sys.executable, "-m", "venv", venv])
    print("[ner] installing onnx + onnxruntime into project .venv")
    subprocess.check_call(
        [py, "-m", "pip", "install", "--quiet", "onnx", "onnxruntime"]
    )
    os.environ["_NER_BOOTSTRAPPED"] = "1"
    os.execv(py, [py, os.path.abspath(__file__)] + sys.argv[1:])


def remote_size(url):
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            n = r.getheader("Content-Length")
            return int(n) if n else -1
    except Exception:
        return -1


def fetch(repo, name, dest):
    url = f"https://huggingface.co/{repo}/resolve/main/{name}"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    want = remote_size(url)
    if want > 0 and os.path.exists(dest) and os.path.getsize(dest) == want:
        print(f"[ner] cached {name} ({want / 1e6:.0f}MB)")
        return dest
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
    if want > 0 and got != want:
        os.remove(dest)
        sys.exit(f"error: short download for {name} ({got} != {want} bytes)")
    print(f"[ner] saved {name} ({got / 1e6:.0f}MB)")
    return dest


def main():
    os.makedirs(os.path.join(DEST, "onnx"), exist_ok=True)
    os.makedirs(TMP, exist_ok=True)

    # Authoritative weights + config + vocab from the author repo.
    fetch(JB_REPO, "config.json", os.path.join(DEST, "config.json"))
    fetch(JB_REPO, "model.onnx", os.path.join(DEST, "onnx", "model.onnx"))
    jb_vocab = fetch(JB_REPO, "vocab.json", os.path.join(TMP, "jb-vocab.json"))
    jb_merges = fetch(JB_REPO, "merges.txt", os.path.join(TMP, "jb-merges.txt"))

    # Tokenizer files from the same-vocab port (verified below).
    fetch(TOK_REPO, "tokenizer.json", os.path.join(DEST, "tokenizer.json"))
    fetch(
        TOK_REPO,
        "tokenizer_config.json",
        os.path.join(DEST, "tokenizer_config.json"),
    )
    fetch(
        TOK_REPO,
        "special_tokens_map.json",
        os.path.join(DEST, "special_tokens_map.json"),
    )
    port_vocab = fetch(TOK_REPO, "vocab.json", os.path.join(TMP, "port-vocab.json"))
    port_merges = fetch(TOK_REPO, "merges.txt", os.path.join(TMP, "port-merges.txt"))

    # Check 1: the port must share the author's exact vocab + merges.
    # Compared semantically (parsed JSON, merge rules minus comments) so
    # byte-level trivia like the #version header can't fail the check.
    def load_vocab(p):
        with open(p) as f:
            return json.load(f)

    def load_merges(p):
        # Skip only the #version header: real merges like "# #" start with #.
        with open(p) as f:
            lines = [ln.strip() for ln in f if ln.strip()]
        return [ln for ln in lines if not ln.startswith("#version")]

    if load_vocab(jb_vocab) != load_vocab(port_vocab):
        sys.exit("error: port vocab.json differs from the author repo")
    if load_merges(jb_merges) != load_merges(port_merges):
        sys.exit("error: port merges.txt differs from the author repo")
    print("[ner] port vocab + merges match the author repo")

    # Check 2: the vocab/merges embedded in tokenizer.json must equal them.
    with open(os.path.join(DEST, "tokenizer.json")) as f:
        tok = json.load(f)
    with open(jb_vocab) as f:
        vocab = json.load(f)
    with open(jb_merges) as f:
        merges = [ln.strip() for ln in f if ln.strip()]
    # merges.txt starts with a "#version" header line; tokenizer.json omits
    # it. Only the header goes: real merges like "# #" start with #.
    merges = [m for m in merges if not m.startswith("#version")]
    embedded = ((tok.get("model") or {}).get("vocab") or {})
    embedded_merges = ((tok.get("model") or {}).get("merges") or [])
    if embedded != vocab or [list(m) if isinstance(m, list) else m for m in embedded_merges] != merges:
        # merges may serialize as tuples; compare joined forms as fallback.
        flat = [" ".join(m) if isinstance(m, (list, tuple)) else m for m in embedded_merges]
        if embedded != vocab or flat != merges:
            sys.exit("error: tokenizer.json embeds a different vocab/merges")
    print("[ner] tokenizer.json embeds the author vocab + merges")

    ensure_quant_deps()
    from onnxruntime.quantization import QuantType, quantize_dynamic

    src = os.path.join(DEST, "onnx", "model.onnx")
    dst = os.path.join(DEST, "onnx", "model_quantized.onnx")
    if os.path.exists(dst) and os.path.getsize(dst) > 100 * 1024 * 1024:
        print("[ner] cached model_quantized.onnx")
    else:
        print("[ner] quantizing to int8 (a few minutes, needs ~8GB RAM)...", flush=True)
        try:
            quantize_dynamic(src, dst, weight_type=QuantType.QUInt8)
        except Exception as e:
            print(f"[ner] WARNING: quantization failed ({e}); fp32 stays available")
            if os.path.exists(dst):
                os.remove(dst)
    total = sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _, fns in os.walk(DEST)
        for f in fns
        if ".tmp-verify" not in dp
    )
    print(f"[ner] done: {DEST} ({total / 1e9:.2f}GB). Restart the dev server.")
    print("[ner] layout: config.json, tokenizer.json, onnx/model.onnx"
          + (", onnx/model_quantized.onnx" if os.path.exists(dst) else " (fp32 only)"))


if __name__ == "__main__":
    main()
