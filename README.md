# ExtBrain <img align="right" width="120" src="./public/extbrain.svg" alt="ExtBrain Logo">

> **The local, anti-RAG cure for AI amnesia.**

> Proudly built 100% by Meta Muse Code for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon).

<img width="494" height="593" alt="image" src="https://github.com/user-attachments/assets/eea4cea4-5370-41bc-a121-050a43cac5a5" />

## The Problem

Long-running AI chats suffer from progressive amnesia. As conversations stretch across weeks or months, valuable insights, decisions, learning notes, and project iterations get buried across thousands of messages. Finding past breakthroughs or organizing what you actually discussed is like searching for a needle in a digital haystack. 

## What We Are Building

ExtBrain is, first and foremost, a **productivity tool for humans**. 

Let's face it: no one can keep track of tens of thousands of chats across multiple AIs and remember all the discussions and conclusions. We built this companion app for people like you and me to thread those needles together. 

Instead of relying on AI to guess what's important, ExtBrain empowers humans to extract exact insights from their historical chat data.

<img width="498" height="532" alt="image" src="https://github.com/user-attachments/assets/ad79819d-8e73-47dc-83c4-252948c4e756" />


### Core Capabilities

*   **Multi-Source Import:** Load ChatGPT exports, Gemini / Google Search AI Mode Takeout, and Obsidian notes into one searchable library.
*   **Granular Entity Search:** Look for specific threads involving certain people, products, brands, companies, topics, or places.
*   **Smart Tags:** Tag chats with natural language like:
    *   *"Extract all our discussions, copy iterations, and performance results around user acquisition."*
    *   *"Pull together everything we figured out about our database schema redesign."*
*   **Thread Categories & Activity Breakdown:** Every thread is classified into a 9-category taxonomy (business, finance, health, …); the activity view shows screen-time-style duration, chat, and thread stats per category.
*   **Insight Generation:** One-click Summarize button with six built-in templates — Milestone Timeline, Learnings, Action Items, Retrospective, Decisions, Research Summary — plus your own custom templates. Outputs include TL;DRs, reports, and action items with deadlines and Add-to-Calendar links.
*   **Voice-Agent:** Ask years of chats anything out loud — hands-free auto-send on end of speech — and get answers synthesized from your history.
*   **Top of Mind & Action Items:** Dedicated views that keep decisions, open loops, and extracted tasks in front of you.

## Technical Architecture: Anti-RAG

Technically, ExtBrain **is not a RAG** (Retrieval-Augmented Generation) system. It is a lightweight web application designed to run locally on your machine (`localhost`) or via our hosted web platform at [extbrain.ai](https://extbrain.ai).

Instead of chunking text and using vector similarities to guess relevance, ExtBrain uses deterministic extraction and structuring:

*   **On-Device NER (XLM-R) [Meta-based]:** Davlan XLM-RoBERTa-base NER — fine-tuned from Meta's FacebookAI/xlm-roberta-base — runs locally via quantized ONNX to extract people, organizations, places, and dates directly from raw messages.
*   **On-Device NLI Tagging (MiniLMv2):** A multilingual MiniLMv2 (Meta XLM-R-based) zero-shot classifier scores Smart Tags and thread categories locally.
*   **Modal NER/NLI Option:** Settings offers a Modal-hosted backend (Davlan XLM-R NER + MiniLMv2 NLI, same models as local) for massive chat repositories; the Load page processes through it when selected, otherwise the local models do the work.
*   **Meta Muse Models:** Leverages Meta Muse models for highly accurate summarization and synthesis.
*   **Bring-Your-Own-Key (BYOK):** Full flexibility to plug in your Meta model keys.

## Getting Started

```bash
git clone https://github.com/ainovo/extbrain-meta.git
cd extbrain-meta
npm install
npm run prepare:ner   # one-time XLM-R NER weights (~1.4GB, pre-quantized ONNX port)
npm run dev           # app at http://localhost:5173 (API on :8080)
```
## License
Copyright (c) 2026 Ainovo Co.

This project is licensed under the GNU Affero General Public License v3.0 (AGPLv3). See the `LICENSE` file for full details.
