---
name: feedback-web-search-first
description: User requires web search first before making any factual claim about external products, models, services, APIs, or anything outside the codebase
metadata:
  type: feedback
---

**Rule:** Before stating anything as fact about external products, model names/versions, third-party APIs, services, libraries, or anything I cannot directly verify from the codebase in front of me, USE THE WEB FIRST. Do not rely on training-data memory. Do not say "I don't think X exists" or "the current names are Y" without a fresh web search confirming it.

**Why:** User explicitly told me DeepSeek has a V4 Pro model and asked me to use it. Instead of verifying via web, I said the name "doesn't ring a bell" and listed model slugs from memory — training data is out of date (today is 2026-05-22). The user was rightly furious: "for everything you tell me from now on, the first thing you'll do is you'll use the fucking web." They had also asked me earlier in this same conversation to "use the web to find out what is rocket money" — same pattern, I didn't fully comply then either.

**How to apply:**
- Any time I'm about to state a fact about an external product (model names, API endpoints, pricing, features, library versions, third-party tool capabilities), search the web BEFORE writing the response.
- When the user names a specific product/version/feature, default position is "they know better than my training data" — verify via search, do not contradict from memory.
- When the user asks me to "look something up" or "use the web to find out X" — that is mandatory, not optional.
- If web is unavailable for some reason, say so explicitly rather than falling back to training-data assertions.
