import os
import re
import modal

app = modal.App("extbrain-inference")

# 100% Meta XLM-RoBERTa Architecture Stack
# Option A for NLI: "MoritzLaurer/bge-m3-zeroshot-v2.0" (Uses Meta XLMRobertaForSequenceClassification)
# Option B for NLI: "symanto/xlm-roberta-base-snli-mnli-anli-xnli" (Direct fine-tune of FacebookAI/xlm-roberta-base)
NLI_MODEL = "symanto/xlm-roberta-base-snli-mnli-anli-xnli"

# Option A for NER (Recommended - EN + Chinese + proper B-/I- tags, built on FacebookAI/xlm-roberta-base):
NER_MODEL = "Davlan/xlm-roberta-base-ner-hrl"
# Option B for NER (If you strictly want the 'FacebookAI/' org prefix in your code):
# NER_MODEL = "FacebookAI/xlm-roberta-large-finetuned-conll03-english"

DEFAULT_CATEGORIES = [
    "Productivity",
    "Finance",
    "Business",
    "Social",
    "Entertainment",
    "Health",
    "Travel",
    "Utilities",
    "Education",
]

DEFAULT_NER_LABELS = ["PER", "ORG", "LOC"]


def download_models():
    import torch
    from transformers import pipeline

    pipeline("zero-shot-classification", model=NLI_MODEL, torch_dtype=torch.float16)
    pipeline("ner", model=NER_MODEL, aggregation_strategy="first", torch_dtype=torch.float16)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch",
        "transformers[sentencepiece]",
        "accelerate",
        "fastapi[standard]",
        "pydantic",
    )
    .run_function(download_models)
)


def clean_markdown_for_ner(text: str) -> str:
    text = re.sub(r"```[\s\S]*?```", " ", text)            # Strip fenced code blocks
    text = re.sub(r"`[^`]*`", " ", text)                   # Strip inline code
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r" \1 ", text)  # [Anchor](url) -> Anchor
    text = re.sub(r"https?://\S+", " ", text)              # Strip raw URLs
    # Insert space between Chinese and English/numbers so XLM-RoBERTa never merges them
    text = re.sub(r"([\u4e00-\u9fff])([a-zA-Z0-9])", r"\1 \2", text)
    text = re.sub(r"([a-zA-Z0-9])([\u4e00-\u9fff])", r"\1 \2", text)
    # Pad punctuation/brackets so SentencePiece never glues brackets onto words
    text = re.sub(r"([.,!?;:()[\]{}\"#*~_>|\\/-])", r" \1 ", text)
    return re.sub(r"\s+", " ", text).strip()


def snap_to_whole_word(text: str, start: int, end: int) -> str:
    """
    Prevents subword clipping like 'Soldier Boy' -> 'dier boy'.
    If XLM-RoBERTa tags a middle/trailing subword of an English word,
    expand start/end indices outward to the full Latin word boundary.
    """
    n = len(text)
    while start > 0 and text[start - 1].isascii() and text[start - 1].isalnum():
        start -= 1
    while end < n and text[end].isascii() and text[end].isalnum():
        end += 1
    return text[start:end]


@app.cls(
    gpu="T4",
    image=image,
    scaledown_window=120,       # Scale down after 2 mins idle to save Modal credits
    max_containers=4,
    secrets=[modal.Secret.from_name("extbrain-auth")],
)
class ExtBrainEngine:
    @modal.enter()
    def setup(self):
        import torch
        from transformers import pipeline

        self.nli = pipeline(
            "zero-shot-classification",
            model=NLI_MODEL,
            device=0,
            torch_dtype=torch.float16,
        )
        # aggregation_strategy="first" + snap_to_whole_word completely eliminates subword clipping
        self.ner = pipeline(
            "ner",
            model=NER_MODEL,
            aggregation_strategy="first",
            device=0,
            torch_dtype=torch.float16,
        )

    @modal.method()
    def run_inference(
        self,
        texts: list[str],
        categories: list[str],
        exclude_categories: list[str],
        ner_labels: list[str],
        multi_label: bool = False,
        category_threshold: float = 0.50,
        exclude_threshold: float = 0.65,
        ner_threshold: float = 0.75,
    ):
        if not texts:
            return []

        all_candidate_labels = list(dict.fromkeys(categories + exclude_categories))
        target_set = set(categories)
        allowed_ner_set = {lbl.upper() for lbl in ner_labels}
        effective_multi_label = True if exclude_categories else multi_label

        # 1. Batched Meta XLM-RoBERTa NLI
        truncated_nli = [t[:2000] if t and t.strip() else "empty" for t in texts]
        nli_outs = self.nli(
            truncated_nli,
            all_candidate_labels,
            batch_size=64,
            multi_label=effective_multi_label,
            hypothesis_template="This text is about {}",
        )
        if isinstance(nli_outs, dict):
            nli_outs = [nli_outs]

        # 2. Batched Meta XLM-RoBERTa NER
        cleaned_ner = [clean_markdown_for_ner(t[:1500]) if t else "" for t in texts]
        ner_outs = self.ner(cleaned_ner, batch_size=64)

        results = []
        for idx, (nli_res, entities) in enumerate(zip(nli_outs, ner_outs)):
            clean_text = cleaned_ner[idx]
            score_map = {
                label: round(float(score), 4)
                for label, score in zip(nli_res["labels"], nli_res["scores"])
            }

            target_ranked = [
                (lbl, score_map[lbl]) for lbl in nli_res["labels"] if lbl in target_set
            ]
            matched_categories = [
                lbl for lbl, sc in target_ranked if sc >= category_threshold
            ]

            matched_exclusions = [
                lbl
                for lbl in exclude_categories
                if score_map.get(lbl, 0.0) >= exclude_threshold
            ]

            mentions_flat = set()
            entities_typed = {}
            for e in entities:
                score = float(e["score"])
                if score < ner_threshold:
                    continue

                label = e.get("entity_group", e.get("entity", "")).replace("B-", "").replace("I-", "").upper()
                if allowed_ner_set and label not in allowed_ner_set:
                    continue

                # Recover full word if SentencePiece clipped the prefix (e.g. 'dier boy' -> 'Soldier Boy')
                if "start" in e and "end" in e and e["start"] is not None and e["end"] is not None:
                    raw_word = snap_to_whole_word(clean_text, e["start"], e["end"])
                else:
                    raw_word = e["word"]

                span = re.sub(r"['’]s$", "", raw_word.strip(), flags=re.IGNORECASE)
                span = re.sub(
                    r"^[^a-zA-Z0-9\u4e00-\u9fff]+|[^a-zA-Z0-9\u4e00-\u9fff]+$",
                    "",
                    span,
                )
                if len(span) >= 2 and not span.isdigit():
                    mentions_flat.add(span)
                    key = (span.lower(), label)
                    if key not in entities_typed or score > entities_typed[key]["score"]:
                        entities_typed[key] = {
                            "text": span,
                            "label": label,
                            "score": round(score, 4),
                        }

            top_cat, top_score = (
                target_ranked[0] if target_ranked else ("Uncategorized", 0.0)
            )

            results.append({
                "category": top_cat,
                "category_score": top_score,
                "matched_categories": matched_categories,
                "excluded": len(matched_exclusions) > 0,
                "matched_exclusions": matched_exclusions,
                "scores": score_map,
                "mentions": list(mentions_flat),
                "entities": list(entities_typed.values()),
            })

        return results


@app.function(
    image=modal.Image.debian_slim(python_version="3.11").pip_install(
        "fastapi[standard]", "pydantic"
    ),
    secrets=[modal.Secret.from_name("extbrain-auth")],
)
@modal.asgi_app()
def web_app():
    from fastapi import FastAPI, Header, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel

    api = FastAPI(docs_url=None, redoc_url=None)

    allowed_origins = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
    ]
    if os.environ.get("CLOUD_RUN_URL"):
        allowed_origins.append(os.environ["CLOUD_RUN_URL"])

    api.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_methods=["POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-ExtBrain-Secret"],
    )

    class BatchRequest(BaseModel):
        texts: list[str]
        categories: list[str] = DEFAULT_CATEGORIES
        exclude_categories: list[str] = []
        ner_labels: list[str] = DEFAULT_NER_LABELS
        multi_label: bool = False
        category_threshold: float = 0.50
        exclude_threshold: float = 0.65
        ner_threshold: float = 0.75

    @api.post("/analyze")
    async def analyze(
        payload: BatchRequest,
        x_extbrain_secret: str | None = Header(default=None),
    ):
        expected_secret = os.environ.get("EXTBRAIN_API_SECRET")
        if not expected_secret or x_extbrain_secret != expected_secret:
            raise HTTPException(status_code=403, detail="Unauthorized client")

        engine = ExtBrainEngine()
        results = await engine.run_inference.remote.aio(
            texts=payload.texts,
            categories=payload.categories,
            exclude_categories=payload.exclude_categories,
            ner_labels=payload.ner_labels,
            multi_label=payload.multi_label,
            category_threshold=payload.category_threshold,
            exclude_threshold=payload.exclude_threshold,
            ner_threshold=payload.ner_threshold,
        )
        return {"results": results}

    return api
