# GPT-5.6 and the `<!-- -->` claim

_Status: working investigation, updated 2026-07-09_

## Bottom line

**The claim is not supported by the evidence reviewed.** OpenAI documents private reasoning tokens for GPT-5.6, but does not document `<!-- -->` as a reasoning token, delimiter, or protocol marker. The exact character sequence is ordinary HTML-comment syntax and could be introduced by a UI, renderer, sanitizer, framework, or empty-summary placeholder.

The clean local sample also does not contain it: before this investigation began, the nightly OpenPond SQLite database recorded **99 GPT-5.6 Sol model requests across 5 turns in 3 sessions**, and there were **zero exact occurrences** of `<!-- -->` anywhere in stored events. Those GPT-5.6 sessions had no persisted `assistant.reasoning.delta` rows, so the database can disprove the marker's presence in the stored event stream, but cannot reveal the model's private chain of thought.

**Assessment:** treat the X claim as unverified speculation. Confidence is high that public OpenAI documentation does not support it, and moderate that the local negative result generalizes beyond this client and sample.

## Question and terminology

There are three different claims that should not be conflated:

1. GPT-5.6 uses internal reasoning tokens. OpenAI says it does.
2. The literal text `<!-- -->` appears somewhere in an API response, application database, or rendered page. This is empirically testable at each layer.
3. The entire literal string is one tokenizer token with special reasoning semantics. This requires model-specific tokenizer and protocol evidence; merely seeing the characters would not prove it.

Also, `<!-- -->` is an HTML comment whose payload is one space. `<!---->` is the empty-comment serialization. Browsers normally do not render either as visible text.

## Local SQLite review

### Database and method

Reviewed read-only: the active nightly OpenPond app `state.sqlite`. The investigation used Python's standard SQLite library because the `sqlite3` CLI is not installed.

To avoid contaminating the result with this prompt—which itself contains the marker—all primary counts use a cutoff immediately before the investigation started: **2026-07-09 20:17:00 UTC**.

Queries covered:

- `model_usage_records` filtered to model `gpt-5.6-sol`;
- stored `events.payload` values for the exact literal marker;
- reasoning-like event names and GPT-5.6-associated sessions/turns;
- comparison with stable and harbor-state databases.

### Clean pre-investigation sample

| Measure | Result |
|---|---:|
| GPT-5.6 Sol requests | 99 |
| Distinct GPT-5.6 sessions | 3 |
| Distinct GPT-5.6 turns | 5 |
| Request time range | 2026-07-09 18:28:31–19:04:18 UTC |
| Prompt tokens recorded | 3,859,234 |
| Completion tokens recorded | 30,665 |
| Exact `<!-- -->` occurrences in all pre-investigation events | 0 |
| Persisted `assistant.reasoning.delta` rows in those GPT-5.6 sessions | 0 |

The five turns included three completed turns and two interrupted turns. Their event streams contain assistant output, tool activity, diagnostics, workspace actions, and subagent lifecycle events, but no persisted reasoning-delta event and no marker.

### Contamination check

After the investigation prompt was submitted, the marker began appearing in the live database. Inspection of every match showed that it came from:

- the user's prompt;
- search queries;
- SQL and shell commands looking for the marker;
- tool request/result echoes;
- this investigation's draft text and subagent brief.

At the first post-query snapshot there were 37 matching event rows and 4 matching turn rows. These are not model-origin evidence. This demonstrates why the cutoff and provenance inspection matter: a naive current-database count would produce a false positive.

The stable and harbor-state databases had no GPT-5.6 usage and no exact marker occurrence at the time checked.

### What the local evidence establishes

It establishes that the exact sequence was **not present in the stored event stream of the recent pre-investigation GPT-5.6 sample**. It does not establish how GPT-5.6 internally tokenizes or represents private reasoning, because raw internal reasoning is not stored or exposed in this sample.

## Web and X review

### OpenAI primary documentation

OpenAI's Reasoning Models guide says GPT-5.6 uses internal reasoning tokens before producing a response. It also says those tokens are not visible through the API and that raw reasoning text is not exposed. Documented public structures include reasoning output items, summaries, `encrypted_content`, `reasoning.context`, assistant `phase` values, and reasoning-token usage counts.

The guide does **not** identify `<!-- -->` as a token, delimiter, summary marker, or protocol element.

### Broader web search

Exact and variant searches covered GPT-5.6 with `<!-- -->`, “HTML comment,” “delimiter,” and “reasoning token,” including OpenAI- and X-scoped variants. No credible primary technical source or independently reproducible analysis corroborated the claim. Search coverage was not exhaustive because hosted search quota was exhausted during follow-up and some search surfaces were restricted.

### X search

Recent X searches for the exact marker plus “reasoning token” returned zero posts in the final direct query. A broader GPT-5.6 query returned general launch and token-efficiency discussion, but nothing establishing the marker's semantics.

An earlier search receipt referenced a post claiming a “null HTML comment” replaced reasoning summaries, but a direct post read was unsupported by the current X adapter and independent exact searches did not corroborate it. Even taken at face value, that claim concerns a displayed or serialized **summary**, not proof of a private reasoning token.

## Competing hypotheses

| Hypothesis | Evidence | Assessment |
|---|---|---|
| `<!-- -->` is GPT-5.6's internal reasoning token | No official or tokenizer/protocol evidence; internal tokens are hidden | Unsupported |
| It delimits exposed chain of thought | Official API uses structured reasoning items; no local marker | Unsupported and unlikely |
| It is an absent-summary or UI placeholder | Ordinary invisible HTML syntax; plausible rendering behavior | Plausible, not proven here |
| OpenPond inserts it for GPT-5.6 | Clean pre-investigation sample has zero occurrences | No evidence |
| Investigation text caused current matches | Proven by row-level provenance inspection | Confirmed |

## Decisive follow-up test

For stronger evidence, run repeated prompts against a fixed GPT-5.6 snapshot while capturing each boundary separately:

1. raw streamed SSE or WebSocket frames;
2. final Responses API JSON, especially reasoning `summary` and `encrypted_content` fields;
3. the application's normalized event objects;
4. persisted SQLite rows;
5. rendered DOM/HTML;
6. `usage.output_tokens_details.reasoning_tokens`.

Compare runs with `reasoning.summary: "auto"`, an explicitly requested summary where supported, and no summary. If the marker first appears in the DOM, it is a presentation artifact. If it appears in raw summary text, it is a service-level summary representation. Neither result alone would prove that the whole string is a single tokenizer token or a private reasoning delimiter.

## Sources

- OpenAI Developers, **Reasoning models | OpenAI API**, accessed 2026-07-09: https://developers.openai.com/api/docs/guides/reasoning
- WHATWG, **HTML Standard §13.1.6 Comments**, accessed 2026-07-09: https://html.spec.whatwg.org/multipage/syntax.html#comments
- X recent-search results through the connected `0xglu` account, searched 2026-07-09.
- Local OpenPond SQLite schema and read-only queries, checked 2026-07-09.

## Update log

- 2026-07-09: Replaced the initial draft's wrong-database sample with the active nightly database; added a clean pre-investigation cutoff, GPT-5.6 usage counts, provenance analysis of post-query false positives, external-source review, limitations, and a decisive follow-up protocol.
