# ExtBrain <img align="right" width="120" src="./public/extbrain.svg" alt="ExtBrain Logo">

> **The local, anti-RAG cure for AI amnesia.**

> Proudly built 100% by Meta Muse Code for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon).

<img width="496" height="596" alt="image" src="https://github.com/user-attachments/assets/8f6370a0-0edb-4cc7-8498-d063ab4a7f53" />

## The Problem

Long-running AI chats suffer from progressive amnesia. As conversations stretch across weeks or months, valuable insights, decisions, learning notes, and project iterations get buried across thousands of messages. Finding past breakthroughs or organizing what you actually discussed is like searching for a needle in a digital haystack. 

## What We Are Building

ExtBrain is, first and foremost, a **productivity tool for humans**. 

Let's face it: no one can keep track of tens of thousands of chats across multiple AIs and remember all the discussions and conclusions. We built this companion app for people like you and me to thread those needles together. 

Instead of relying on AI to guess what's important, ExtBrain empowers humans to extract exact insights from their historical chat data.

### Core Capabilities

*   **Granular Entity Search:** Look for specific threads involving certain people, products, brands, companies, topics, or places.
*   **Smart Tags** Tag chats with natural language like:
    *   *"Extract all our discussions, copy iterations, and performance results around user acquisition."*
    *   *"Pull together everything we figured out about our database schema redesign."*
*   **Insight Generation:** Ask ExtBrain to generate tl;drs, retrospectives, weekly reports, project milestones, and action items from past conversations.
*   **Voice-Agent:** Use voice chat to give ExtBrain requirements, and it will respond with exactly what you need from your history.

## Technical Architecture: Anti-RAG

Technically, ExtBrain **is not a RAG** (Retrieval-Augmented Generation) system. It is a lightweight web application designed to run locally on your machine (`localhost`) or via our hosted web platform [Link TBD].

Instead of chunking text and using vector similarities to guess relevance, ExtBrain uses deterministic extraction and structuring:

*   **Meta RoBERTa (On-Device):** Utilizes an on-device Meta NLI classifier to extract entities directly from raw messages. 
*   **Cloud NER Option:** Provides an option to connect to cloud-based Named Entity Recognition (NER) services to expedite processing for massive chat repositories.
*   **Meta Muse Models:** Leverages Meta Muse models for highly accurate summarization and synthesis.
*   **Bring-Your-Own-Key (BYOK):** Full flexibility to plug in your Meta model keys.

## Getting Started

```bash
# Example placeholder for local setup
git clone https://github.com/ainovo/extbrain-meta.git
cd extbrain-meta
npm install
npm run dev
```
## License
Copyright (c) 2026 Ainovo Co.

This project is licensed under the GNU Affero General Public License v3.0 (AGPLv3). See the `LICENSE` file for full details.
