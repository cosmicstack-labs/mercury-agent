---
slug: mercury-weekly-1
title: "Mercury Weekly #1: IPOs, models and agents that pay"
description: "The week of 9 to 15 November 2026: Anthropic's IPO roadshow, Nvidia's CEO change, new frontier models, ChatGPT Wallet and the Decisions API."
authors: [tashiriskhan]
tags: [weekly, news, ai-agents, security]
image: ./cover.jpg
keywords: [mercury weekly, ai news this week, anthropic ipo, claude fable 5.2, ai agents payments, gemini 4 carbon]
draft: false
---

This week, AI moved on four fronts at once: the companies behind it moved toward public markets, the frontier models got stronger, developer tools started offering several models instead of one, and agents began to spend money on users' behalf. Each of these is a separate story, but read together they point the same way. This is the first Mercury Weekly, covering 9 to 15 November. There was no Mercury release this week.

{/* truncate */}

## Anthropic begins its IPO roadshow

On 10 November, Anthropic launched the roadshow for its proposed initial public offering. [Anthropic says](https://www.anthropic.com/news/roadshow-launch) it plans to offer 825 million Class A shares at an expected price of $70 to $78 per share, and has applied to list on Nasdaq under the ticker `ANT`. Of those shares, 801,351,354 are being sold by Anthropic and 23,648,646 by existing stockholders, so the company itself will receive the proceeds. The offering is still proposed, so the price and timing can change. This is the biggest financial story of the week, and it means one of the leading AI labs is about to be judged by public investors.

## Nvidia's CEO steps down

On 12 November, Jensen Huang resigned as Nvidia's President, CEO and board member, effective immediately. CFO Colette Kress became interim CEO, and the board has started a search for a permanent successor. [Nvidia's announcement](https://nvidianews.nvidia.com/news/nvidia-announces-ceo-transition) also named Harvey Jones as the board's first independent chair, and said the company expects operations, customer commitments and its product roadmap to continue without interruption.

The resignation came amid reports about Huang's personal conduct, including a reported relationship with a suspected Chinese intelligence agent. Several outlets, including [The Guardian](https://www.theguardian.com/technology/2026/nov/12/nvidia-ceo-jensen-huang-resigns) and [CBS News](https://www.cbsnews.com/news/nvidia-ceo-jensen-huang-resigns/), have reported those allegations. Nvidia's stock reflected the uncertainty. [CNBC](https://www.cnbc.com/2026/11/13/nvidia-stock-jensen-affair-ai.html) reported that shares fell about 13% that week, the sixth straight weekly loss and the longest such run since 2012. The question for the industry is whether a new CEO changes Nvidia's strategy, and Nvidia's next earnings report on 17 November should give the first hint.

## Frontier models: Claude Fable 5.2, Mythos 5.2 and Gemini 4 Carbon

On 9 November, Anthropic released Claude Fable 5.2 and Mythos 5.2, upgraded models for difficult technical work with gains in coding, reasoning and vision. Anthropic says the two [are the same underlying model](https://www.anthropic.com/claude-fable-and-mythos-5-2). The difference is access. Fable has strong cybersecurity and biology safeguards, so it is available to all users. Mythos is available to organizations that apply through Anthropic's verification programs for life sciences and cybersecurity research. Anthropic lists Fable 5.2 at $8 per million input tokens and $40 per million output tokens, and says it generates output up to 30% faster than Fable 5.1.

On 10 November, Google made [Gemini 4 Carbon](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-carbon-now-available/) available to developers, enterprises and consumers. Google describes Carbon as its strongest model, with frontier cybersecurity performance and long-horizon agentic workflows across complex knowledge work, software engineering and scientific reasoning. It sits above Gemini 4 Argon, which Google still recommends for most software engineering and knowledge work. Carbon is for harder problems that need more tokens. Its API pricing is $2 per million input tokens and $10 per million output tokens.

## ChatGPT Wallet: agents that pay

On 13 November, OpenAI introduced ChatGPT Wallet, which lets dots, its agents inside ChatGPT, complete purchases for a user. According to [OpenAI's announcement](https://openai.com/index/introducing-chatgpt-wallet/) and launch coverage, the feature starts with a limited group of U.S. ChatGPT Pro subscribers. Every purchase requires the user's approval, typically with a biometric check such as Face ID or a fingerprint.

The detail that matters most for developers is the credential. OpenAI says the agent and the merchant receive a substitute payment credential, not the real card number, so the user's card stays out of the agent's hands. That makes "agents that pay" concrete: the approval step and the payment token are where the trust decision is made, and they are what to watch as the feature widens.

## Google's Decisions API

On 11 November, Google launched the Decisions API, powered by a new model, Gemini Decision 1. It is built for bounded choices rather than open-ended text. Google's [launch post](https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/) lists the uses as tool selection, policy checks, model routing and context grading.

For developers, the interesting part is the shape of the call. One request can carry text, images, audio, video or PDFs, up to 256K tokens, along with up to 1,000 independent questions. Each question is a yes/no check, a multiple-choice selection or a rubric score, and every answer comes with a confidence score from 0 to 1, so ambiguous cases can go to a fallback model or a person. Google claims end-to-end latency of 150 to 250 ms, and pricing of $0.10 per million input tokens with no charge for output tokens. Those figures explain why someone would use it instead of a generative call: a fast, cheap yes/no or routing decision does not need a model to write text. These are Google's figures, and we have not tested them.

## Also this week

**Git patches six security vulnerabilities.** On 10 November, the Git project released fixes for six vulnerabilities in [Git 2.56.1](https://github.blog/open-source/git/git-security-vulnerabilities-announced-7/) and backports to several earlier maintenance lines. The most serious, CVE-2026-111760, can run attacker-controlled code during a recursive clone of a malicious repository. Others cover path traversal, memory corruption during merges and binary patches, and file access through fast-import streams. GitHub recommends updating to Git 2.56.1, or the patched release for your maintenance series, and updating any application that bundles its own copy of Git. If you cannot update immediately, clone only from trusted servers and avoid recursive clones of untrusted repositories.

**GitHub Copilot added three models between 9 and 13 November.** GitHub added Claude Fable 5.2 on 9 November, Gemini 4 Carbon on 10 November and Gemini 4 Hydrogen on 13 November, according to its [changelog](https://github.blog/changelog/). My read: developer tools are becoming surfaces where you pick between models, not products tied to one model.

**The Fed warns about AI and jobs.** On 12 November, Federal Reserve Governor Michael Barr said at Yale that the U.S. should prepare for possibly significant labor-market disruption and greater inequality as AI adoption speeds up. He stressed that the eventual effects are still uncertain.

## The signal

Taken together, this week's stories suggest AI is becoming an ecosystem rather than a model market. Anthropic is preparing to become a public company, so its growth will soon be judged by quarterly results as well as benchmarks. Developers no longer have to choose one model for everything, because Copilot offers several at once and Google's Decisions API is built to route work between models. And agents have moved from recommending purchases to making them, with approval and payment tokens as the safeguards. The stories are about different companies, but they share one direction: the value is shifting from any single model to the systems that connect models, tools, money and people.

## Mercury this week

No Mercury release this week. We'll include product updates here when there's something worth reporting.

## Sources

- Anthropic, IPO roadshow launch: https://www.anthropic.com/news/roadshow-launch
- NVIDIA Newsroom, CEO transition announcement: https://nvidianews.nvidia.com/news/nvidia-announces-ceo-transition
- CNBC, Nvidia stock and the CEO affair story, 13 Nov 2026: https://www.cnbc.com/2026/11/13/nvidia-stock-jensen-affair-ai.html
- [The Guardian](https://www.theguardian.com/technology/2026/nov/12/nvidia-ceo-jensen-huang-resigns), reporting on Jensen Huang's resignation, 12 Nov 2026
- [CBS News](https://www.cbsnews.com/news/nvidia-ceo-jensen-huang-resigns/), reporting on Jensen Huang's resignation, 12 Nov 2026
- Anthropic, Claude Fable 5.2 and Mythos 5.2: https://www.anthropic.com/claude-fable-and-mythos-5-2
- Google, Gemini 4 Carbon now available: https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-carbon-now-available/
- OpenAI, Introducing ChatGPT Wallet: https://openai.com/index/introducing-chatgpt-wallet/
- Google, Gemini Decisions API launch: https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/
- The GitHub Blog, Git security vulnerabilities announced: https://github.blog/open-source/git/git-security-vulnerabilities-announced-7/
- GitHub Changelog, Copilot model additions: https://github.blog/changelog/
- Federal Reserve, Governor Michael Barr's speech at Yale, 12 Nov 2026: https://www.federalreserve.gov/newsevents/speech/barr20261112a.htm
