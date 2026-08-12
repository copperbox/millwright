# AWS Cost Analysis

The analysis below is assembled from the spec's own cost anchors (§16), the source tickets (001, 002, 008, 012), and the council's re-derivations in c5 (poller wall-clock) and c14 (Step Functions), extended to a full line-item view. US-East list prices, single deployment, all 50 repos watched at the default 1-minute `pollCadence`.

## 1. Standing costs — 50 repos watched, zero runs

These accrue whether or not anything ever builds:

| Line item | Monthly | Basis |
|---|---|---|
| KMS CMK (C14) | $1.00 | Flat per-key fee (ticket 008 — the design's one deliberate standing cost). Decrypt API calls (poller cold-start `GetParameters` batches, per-job secret resolution) at $0.03/10k add cents. |
| Poller Lambda (C2) | $1.20–2.40 | c5's pinned model: ~7–8 s/tick at 50 repos with 10-way `ssh2` fan-out → 43,200 ticks/mo × ~8 s ≈ 345k Lambda-seconds; at 256 MB ARM (~$0.0000133/GB-s) ≈ $1.15 compute + tier-2 ETag polling time. Consistent with ticket 002's $0.80–2.40 band, landing at the top of it at 50 repos. |
| EventBridge Scheduler tick (C1) | $0.04 | 43,200 invocations × $1.00/M. |
| DynamoDB polling table (C10) | $0.15–0.30 | 50 ref-map reads per tick = 2.16M reads/mo; at moderate ref counts (compressed map ≤ 4 KB) that is ~1–2M read units at $0.125/M. Writes happen only on ref change (emit-then-commit, §6.1) and are workload-driven. |
| Sweep (C16) + reporter sweep path (C8) | $0.20–0.50 | Two per-minute short Lambdas, ~86k invocations/mo combined. |
| SSM Parameter Store (C15) | $0.00 | Standard tier: 50 deploy keys + repo configs + App PEM are free. This is amendment 2's payoff — Secrets Manager at $0.40/secret/mo would be ~$21/mo for the same material. |

**Idle subtotal: ≈ $2.60–4.30/mo.** The spec's framing invariant ("the only standing costs are the CMK and the polling Lambda") holds; everything else standing is sub-dollar.

Two standing-cost caveats the band assumes away:

- **Ref-count sensitivity** (c5/§6.1): the per-tick `ls-refs` response scales with the watched repo's ref count (~65 B/ref). A 5,000-ref repo means a hundreds-of-KB response and a compressed ref-map item costing tens of read/write units per touch — one such repo can add roughly $1–5/mo of C10 I/O by itself. The band assumes moderate ref counts, as §16 now states.
- **Non-VPC is load-bearing**: putting the poller in a VPC would add a ~$32/mo NAT gateway — roughly 10× the entire idle stack (ticket 002).

## 2. Workload-driven costs — anchored to §16's mid workload

Anchor: 100 runs/day × 5 min average build (≈ 2 runs/repo/day across 50 repos, ~5 jobs/run), the same example the spec's compute row uses.

| Line item | Monthly | Basis |
|---|---|---|
| CodeBuild — user jobs | **$51** (+5–15% rounding) | 15,000 build-min/mo × ~$0.0034/min on ARM `BUILD_GENERAL1_SMALL` (ticket 001). Full ticket range: $10–204/mo across 50×2 min → 200×10 min. Per-minute rounding adds 5–15% at typical job lengths. |
| CodeBuild — synth jobs | **$10–20** | Every run starts with a synth (§7.2): 100/day × ~1–2 min (clone + install + synth) at the same rate. Not itemized in §16's table (it is the same compute rate); the pre-approved Lambda-compute escape hatch would shrink it if it ever matters. |
| CloudWatch Logs — ingestion (C17) | **$8–38** | The sleeper: $0.50/GB ingested. ~500 job-builds/day at 1–5 MB of logs each = 0.5–2.5 GB/day. Storage at 30-day retention adds ~$1–2. This is the one line item that can rival compute, and it is driven almost entirely by build verbosity. |
| S3 — artifacts, source, cache (C12) | **$2–10** | Storage-dominated: at 10–50 MB/run (source.tar.gz + artifacts) with 90-day retention, steady state is ~90–450 GB × $0.023/GB. Dependency caches add ~50 × a few hundred MB ≈ $0.25–0.50. Requests negligible. |
| Step Functions Standard (C5) | **$3–6** | c14's arithmetic: 4–6 transitions/iteration; a 5-job run wakes ~10–15 times ≈ 50–90 transitions ≈ $0.002/run at $25/M — "tenths of a cent per typical run," × 3,000 runs/mo. A run pinned at the retry caps costs ~$0.20/day, bounded by the 24 h deadline. |
| DynamoDB state table (C9) | **$0.20–0.50** | Run/job/step/dedupe/`BUILD#` writes ≈ 5–8k/day ≈ 200k write units/mo at $0.625/M, plus CLI/decider/reporter reads and stream reads of similar order. |
| EventBridge bus (C3) | **$0.05–0.10** | Push/cron/dispatch events plus shim step events (c3 moved step status onto the bus): ~2–3k events/day × $1/M. |
| Control-plane Lambdas (launcher, decider, build-events, C19, reporter stream path) | **$0.20–1.00** | Thousands of short invocations/day. |
| IAM roles, GitHub App API | $0.00 | Stable roles (§10.2) are free; App budget ≈ 3,000 tier-2 req/hr worst case + ~1,500 check calls/day, inside the 5,000/hr installation limit (§6.2, §13.2). |

**Workload subtotal at the anchor: ≈ $75–125/mo.**

## 3. The whole picture at 50 repos

| Scenario | Monthly total |
|---|---|
| Watched but idle (vacation week) | **~$3–4** |
| Light (25 runs/day × 3 min) | **~$18–30** |
| Mid — §16's anchor (100 runs/day × 5 min) | **~$80–130** |
| Heavy (200 runs/day × 10 min) | **~$260–330** (CodeBuild ~$204 + synth ~$40 + logs/S3 scaling with it) |

Dominance ordering is stable across scenarios: **CodeBuild compute ≫ CloudWatch Logs ingestion > S3 storage > Step Functions > polling stack > everything else.** Marginal cost is ~$0.004–0.005 per build-minute all-in (compute + rounding + logs + orchestration), so capacity planning reduces to build-minutes; the fixed floor for having 50 repos watched and triggerable is a few dollars.

Points already settled in council that bound this analysis: the binding constraint at 50 repos is poller **wall-clock** (~7–8 s/tick), not dollars (c5's ruling — the $0.80–2.40 polling band survives to ~N≈100 with schedule sharding as the documented growth path); the SFN and large-ref caveats are §16's own rows (c14, c5); and the two structural cost avoidances — no NAT (~$32/mo) and no Secrets Manager (~$21/mo at 50 repos) — are ticket 002 and amendment 2 respectively. The one number I'd watch in production that §16 does not carry as a row is CloudWatch Logs ingestion: it is the only item whose worst case approaches the compute bill, and it is controlled entirely by team log discipline, not by millwright's design.
