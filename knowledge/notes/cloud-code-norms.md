---
type: Panel Transcript Note
title: "Cloud Code team norms — bottlenecks, reviews, and org structure with Fiona"
description: >-
  Fiona Fung (Anthropic, Cloud Code engineering lead) shares how the team rewrote
  its norms as coding stopped being the bottleneck — covering JIT planning, competing
  PRs for technical debates, trust-but-verify code review, flat org with IC-first
  managers, and metrics to validate the shift.
contract_version: okf-note-contract/1.0.0
source:
  source_key: granola:8fc079ac-2881-419c-b54b-53a458af9ff5
  kind: granola
  origin: granola:8fc079ac-2881-419c-b54b-53a458af9ff5
  content_sha256: ba7c3f2cdd122b06c8a28ee4687535afc9f87adbd4df5c43771e8d85fc026250
  acquired_at: "2026-06-26T00:00:00.000Z"
tags:
  - team-norms
  - cloud-code
  - engineering-leadership
  - ai-adocao
  - code-review
  - org-structure
  - produtividade
claims:
  - id: claim-001
    text: >-
      For years engineering bandwidth was the expensive bottleneck; on the Cloud Code
      team coding is rarely the slow part anymore — throughput has increased dramatically
      and new bottlenecks have shifted to verification, code review, cross-functional
      sign-off, and security.
    anchors:
      - speaker-002
  - id: claim-002
    text: >-
      Processes quietly stop working but rarely kill themselves — teams layer more
      and more process on top. What served you prior may not serve you any longer.
      Planning norms, code ownership questions, design docs before every feature, and
      traditional code review are all candidates for defragmentation.
    anchors:
      - speaker-003
  - id: claim-003
    text: >-
      JIT planning replaced six-month roadmaps at Cloud Code — the team wrote a
      six-month roadmap that was already stale within three months, so they shifted
      to just-in-time planning matched to the pace of change.
    anchors:
      - speaker-004
  - id: claim-004
    text: >-
      Technical debates are now settled by generating competing PRs instead of
      whiteboard sessions. Generating three PR options with Claude lets the team
      debate not only implementation but also the impact on all callers of an API.
    anchors:
      - speaker-004
  - id: claim-005
    text: >-
      Cloud Code replaced design docs and product reviews with prototypes and
      PRs. Most discussions happen in PRs or as running prototypes; the team ships
      to internal users quickly to get real feedback rather than doing upfront reviews.
    anchors:
      - speaker-005
  - id: claim-006
    text: >-
      The team doubled down on shift-left verification as code throughput increased —
      more automation to catch bugs earlier at the source, giving everyone (including
      designers and PMs who now ship code) confidence that their changes do not
      introduce regressions.
    anchors:
      - speaker-006
  - id: claim-007
    text: >-
      Claude handles style, lint, PR feedback, bug fixes before commit, and test
      additions. Human review is reserved for legal, security-sensitive code, trust
      boundaries, and product taste — the trust-but-verify principle applied to
      code review.
    anchors:
      - speaker-007
  - id: claim-008
    text: >-
      Asking who made this change is less useful when all PRs are Claude-assisted;
      the better question is what you are actually trying to answer — finding a
      regression root cause, reaching an expert, or gaining context — and then
      automating that lookup.
    anchors:
      - speaker-007
  - id: claim-009
    text: >-
      Cloud Code indexes on two engineer profiles: creative builders with product
      sense who dream and iterate toward delight, and deep systems experts for hard
      infrastructure problems. Raw throughput is no longer a hiring criterion because
      the models handle it.
    anchors:
      - speaker-008
  - id: claim-010
    text: >-
      Cloud Code keeps the org as flat as possible and requires every manager to
      start as an IC first to earn street cred and learn effective engineering with
      AI. Recruiters initially thought no manager would accept that; it filters for
      the right cultural fit early.
    anchors:
      - speaker-009
  - id: claim-011
    text: >-
      The codebase is the source of truth for knowledge sharing; specs are checked
      into repos and Claude is asked to verify code execution against them. Old
      standup spreadsheets were replaced by a Claude-run script that summarizes
      progress for the whole team.
    anchors:
      - speaker-010
  - id: claim-012
    text: >-
      Three metrics to track AI-era team health: onboarding ramp-up time (dramatically
      reduced at Cloud Code), PR cycle time shortening, and caution-to-commit ratio
      going up — nearly 100% of Cloud Code commits have been Claude-assisted for
      the past four months.
    anchors:
      - speaker-011
---

# Summary

Fiona Fung, engineering and product lead for Anthropic's Cloud Code and Cowork, gave this talk at a conference covering how the team rewrote its working norms as AI shifted the fundamental bottleneck in software delivery. The central insight: **when coding stops being expensive, the processes built around expensive coding become liabilities.** Planning norms, design docs, code ownership questions, and traditional code reviews were all quietly stopping working — not loudly failing, just becoming overhead.

The Cloud Code team responded with five structural changes. Planning moved from six-month roadmaps to JIT cadences. Technical debates moved from whiteboarding to generating competing PRs — which also surfaces impact on callers, not just implementation aesthetics. Code review moved to a trust-but-verify model where Claude handles style, lint, tests, and bug-catching before commit, while humans stay in the loop for legal, security, and product taste. Team makeup shifted away from raw throughput toward creative builders with product sense and deep systems expertise. And the org became as flat as possible, with managers required to start as ICs to maintain engineering credibility.

The rollout balanced mandated must-dos (everyone uses Claude Code, including cross-functional partners; everything you can automate, automate; explicit permission to kill old processes) with high pod-level autonomy on how to implement each norm. Fiona measures success through three signals: onboarding ramp-up time falling, PR cycle time shrinking, and virtually all commits being Claude-assisted.

Nota de transcrição: este é um monólogo de único narrador sem marcadores de tempo disponíveis. As afirmações estão vinculadas a blocos temáticos do speaker ("Them") sem precisão de timestamp.

# Key Claims

- **claim-001** — Coding throughput is no longer the bottleneck at Cloud Code; verification, review, security, and cross-functional sign-off now are.
- **claim-002** — Processes quietly stop working but never self-destruct; explicit defragmentation is needed.
- **claim-003** — Six-month roadmaps went stale in three months; JIT planning replaced them.
- **claim-004** — Competing PRs replace whiteboard technical debates; impact on callers visible immediately.
- **claim-005** — Design docs replaced by prototypes and PRs; fast internal feedback loops over upfront planning.
- **claim-006** — Shift-left verification doubled down on as throughput increased; everyone needs regression confidence.
- **claim-007** — Claude owns style/lint/tests/bugs; humans own legal, security, and product taste.
- **claim-008** — "Who made this change?" is the wrong question when all PRs are AI-assisted; ask the underlying question instead.
- **claim-009** — Hiring indexes on creative builders with product sense + deep systems experts; raw throughput is no longer a criterion.
- **claim-010** — Flat org; every manager starts as IC first to earn engineering credibility and stay in the code.
- **claim-011** — Codebase is source of truth; standup spreadsheet replaced by Claude-run summary script.
- **claim-012** — Three team health metrics: onboarding ramp-up, PR cycle time, and ~100% Claude-assisted commits for four months.

# Citations

- **Fonte primária:** Fiona Fung (Anthropic, Cloud Code / Cowork engineering and product lead), capturado via Granola — `granola:8fc079ac-2881-419c-b54b-53a458af9ff5`

# Evidence

**Them [speaker-002]** — shift from coding throughput to new bottlenecks:
> "for years, engineering bandwidth was the expensive thing. Coding throughput was really expensive... on the Cloud Code team, for sure coding is rarely the slow part anymore... the bottlenecks end up shifting towards other areas... verification review, cross functional partners, security"

**Them [speaker-003]** — processes quietly stop working:
> "rarely do processes kill themselves. We tend to just layer more and more and more processes on... the planning norms. We used to spend a lot more time, you know, pre planning because coding time was expensive. Code ownership, there's also be a lot of questions of who who who wrote this code? Who owns it? That's a little bit of an utter question now."

**Them [speaker-004]** — JIT planning and competing PRs:
> "I call it like JIT planning or almost like JIT compiling because even when I first joined, I'm like, don't we need a six month roadmap? You know, we put some effort in, we wrote it, it was pretty good for three months. And then I came back over the new year and so many things had changed already."

> "I generated three PRs. And the cool part about that for the technical debate is I really not only about the implementation of the API, but also the impact to all the callers into the API."

**Them [speaker-005]** — prototypes over design docs:
> "we definitely have reduced the design doc before every code ritual... most of our discussions is, like, instead of a doc, a PR... Hey, we have an idea? Go prototype... we don't really do a lot of product reviews because the landscape is changing fast. So let's prototype."

**Them [speaker-006]** — shift-left verification:
> "what did we double down on? The verification. Because, again, it's like the throughput is different and there are new ways to break... I call it kind of shift left... more automation so we catch it earlier to the source."

**Them [speaker-007]** — trust-but-verify code review:
> "we definitely have Claude handle all the style and lint and PR feedback requests, even like maybe catching some bugs and fixing them before it even, does the full commit. Also adding tests... But where I still definitely want a human is that expertise... legal review... security sensitive code. I still want to make sure pulling in the experts."

**Them [speaker-007]** — rethinking "who made this change":
> "because all our all our PRs are assisted by Claude, a little bit of an odd question... double click to what question you're really trying to answer. Are you looking for who caused this regression?... Are you looking for an expert to answer a customer question? Are you looking to gain context?"

**Them [speaker-008]** — team makeup priorities:
> "there's two profiles for engineers that I've really heavily indexed on. One are, like, creative builders with product sense... The other one is deep systems expertise... what I indexed less less on is raw throughput because, thanks to the models, we're just a lot more efficient."

**Them [speaker-009]** — flat org and IC-first managers:
> "I really structured the org to be as flat as possible because I want us to be super agile... I wanted every manager in Quadco to start out as an IC first... my recruiters had some concerns because I remember they said, you want to hire managers and will start as an IC first. No manager will be interested in that."

**Them [speaker-010]** — codebase as source of truth, killing old processes:
> "code is a source of truth... explicit permission to kill those processes... we used to do stand ups... we're like, oh, wait. We should just do a a a skill. Right? Like a a stand up script so that we can just run Claude, and all of us can always be much more kept aware of what everybody else is doing."

**Them [speaker-011]** — success metrics:
> "The onboarding ramp up time, that has dramatically reduced... The PR cycle time shortening... by default every commit is cloud assisted. I don't think I've seen a non cloud assisted commit probably in the last four months or so."

**Them [speaker-012]** — audit your noisiest workflow:
> "pick your noisiest workflow... Ask, is this still really serving? What's the purpose of there?... there was a team I was on, where we used to have this weekly review... 50 people... everybody's on their laptops except for when their time to give status report... we canceled it."
