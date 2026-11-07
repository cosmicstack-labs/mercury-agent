---
name: mercury-financial-estimate-refutation
description: Independently audit monetary estimates for arithmetic, denominator, period, assumption and scope errors.
category: finance
id: finance/financial-estimate-refutation
version: 0.1.0
license: MIT
author: 'Cosmic Stack; adapted from Hermes Agent'
intents: [audit-financial-estimate, refute-revenue-forecast]
tags: [finance, evidence, estimates]
allowed-tools: [read_file, run_command, use_skill, ask_user, delegate_task]
---

# Financial Estimate Refutation

Curated instructions, not financial advice or a verified financial model. Use to challenge estimates before decisions, not to make transactions. Obtain the exact claims, source documents, covered periods, currencies and operating scope. Missing inputs are unresolved evidence, not zero values. Obtain approval before changing a model or accessing additional private records; no account access, uploads or purchases are authorized by this skill.

## Independent calculation

1. Express each material claim as a formula with named inputs. Mark each input as source-supported, calculated, assumed or unavailable, with a page/row/URL reference. Use `mercury-grounded-citations` for evidence and the web-search skill when current information is needed. Never treat a search snippet as the underlying financial statement.
2. Recalculate with deterministic code through `run_command`, using decimal arithmetic and explicit rounding for money. Inspect units and scale before arithmetic: dollars versus thousands, gross versus net, percentages versus fractions. Guard missing values and zero denominators. Do not execute macros or formulas from untrusted documents.
3. Align numerator and denominator periods and currency conversion dates. Disclose fiscal/calendar mismatches, inflation assumptions and seasonality before annualizing. A six-month numerator with an annual denominator is not a comparable ratio.
4. Verify entity and scope: franchisor revenue is not systemwide sales; one supplier, location or transport leg is not a whole network. Map overlapping legs and intercompany transfers before summing, to avoid double counting.
5. Identify every load-bearing bridge coefficient. Test lower/base/upper assumptions and show which input changes the result most. A sensitivity interval is not a statistical confidence interval. Plausible arithmetic does not verify an unsourced benchmark.
6. Compare with an independently sourced historical or operational anchor where available. Agreement between calculations using the same assumption is not independent corroboration. If a separate reviewer is available and appropriate, delegate a bounded refutation with the same source inputs and verify its calculations yourself; disclose when no independent review ran.

## Output and verification

Return a compact table: claim, draft value, independent result, evidence status and verdict. Distinguish supported, arithmetically wrong, scope/period mismatch and unsupported. For each material failure include the formula, cited input, cause and smallest corrected number or wording. Do not describe an unsupported estimate as invented without evidence.

Before delivery reconcile totals and ratios, review rounding and source definitions, and state the dates and limitations of the analysis. Do not promote an estimate into a fact because a reviewer approves it. No live financial integration or upstream reference files are bundled. Diagnostic calculation artifacts are scoped project outputs; durable personal financial facts and preferences belong only in the Second Brain.
