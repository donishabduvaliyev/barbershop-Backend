# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 5. Developer Skills & Engineering Toolbelt

The following developer skills are installed globally and ready for invocation in any session:

1. **Andrej Karpathy Guidelines** (`karpathy-guidelines`):
   - Strict bias towards minimalism, surgical edits, zero speculative abstractions, and goal-driven verification before and after every modification.
2. **Matt Pocock SDLC Skills** (`mattpocock/skills`):
   - `grill-me`: Relentless design-tree interview to sharpen ambiguous requirements, uncover hidden assumptions, and settle all prerequisites before code is written.
   - `to-spec`: Transform user requests into unambiguous specifications with inputs, outputs, edge cases, and verifiable criteria.
   - `to-tickets`: Decompose complex epics into small, self-contained, reviewable tickets.
   - `implement`: Test-driven, surgical implementation following specifications.
   - `diagnosing-bugs`: Systematic bug reproduction, hypothesis generation, and root cause isolation.
3. **Anthropic Claude Code Security Review** (`claude-security-review`):
   - High-confidence vulnerability audit targeting injection risks (SQL/NoSQL/Command/XSS), authentication/authorization bypasses, IDOR, sensitive PII leakage, and cryptography issues.
4. **Supabase & Postgres Best Practices** (`supabase`, `supabase-postgres-best-practices`):
   - Best practices for database schema design, index performance, transactions, and Row Level Security (RLS).
5. **Convex Agent Skills** (`convex`, `convex-expert`):
   - Reactive backend design, queries, mutations, actions, schemas, and performance tuning.
6. **Emil Kowalski Design & Motion** (`emilkowalski-animate`, `make-interfaces-feel-better`):
   - Natural easing curves (`cubic-bezier`, spring physics), hover lift effects, layout transitions, and micro-interactions.
7. **Impeccable & Taste Skills** (`impeccable`, `taste-skill`, `design-taste`):
   - Elite frontend craft, anti-slop rules, responsive design auditing (`craft`, `shape`, `polish`, `audit`, `bolder`, `quieter`, `harden`), curated palettes, and typography hierarchy.

