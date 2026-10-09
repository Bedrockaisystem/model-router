# model-router

A Claude Code mod that runs each turn, and each subagent, on the smallest model that fits the task. Protected work always stays on the session's own (top) model. It only ever downshifts, and it never touches permissions, approvals or permission mode.

## How it routes

| Task | Tier | Default model |
| --- | --- | --- |
| Architecture, security, auth, migrations/schema/SQL, payments/Stripe/billing, privacy/consent/analytics, secrets, production/deploys, legal, refactors | top | the session's model |
| Implementing, fixing, debugging, writing tests, wiring things up | mid | `sonnet` |
| Typos, renames, formatting, summaries, lookups ("where is…"), test runs, README/changelog touch-ups (short prompts only) | small | `haiku` |
| Anything the rules cannot place, or a brief over 4,000 characters | top | the session's model |

Rules are local regex in `hooks/route.ts`. No prompt leaves the machine for routing unless you set `classifier` to `rules+model`, which asks the small model about prompts the rules cannot place.

Where it acts:

- **Main thread, per turn.** The first request of each turn picks the tier from the prompt; every step of that turn uses it. Empty continuation turns reuse the last tier. In a Claude Projects thread it reads only the human message inside the wake envelope, so harness boilerplate does not pin every turn to top.
- **Subagents, at spawn.** `Explore` and other search agents go small unless the brief is protected; `Plan` stays top; others are classified from their description and prompt. An Agent call that names a model, forks and teammates are left alone.

Safety rails:

- **Escalation.** If a downshifted turn or subagent tries to write a protected path (migrations, supabase, auth, payments, stripe, webhooks, privacy, consent, cookies, security, secrets, `.env`, middleware, RLS, policies) or run a protected command (`supabase`, `psql`, `stripe`, migrate tools, deploys, `git push`, `rm -rf`), that call is refused with a note and the rest of the turn runs on the top model, which redoes it.
- **Context guard.** The main thread never downshifts when the live context is over `contextLimit` (150k tokens), since a smaller model's window may not hold it.
- **Failure fallback.** If the smaller model's request fails before producing output, the step reruns on the session's model and the turn stays there.
- **Fail-open.** If any hook errors, the turn runs unchanged on the session's model.

## Overrides (per thread)

- Type `#route:top`, `#route:mid`, `#route:small` or `#route:auto` anywhere in a message. It sticks for that thread until changed. This works in Projects threads, where slash commands are not typed.
- `/route top|mid|small` pins the tier; `/route auto` clears the pin; `/route suggest` shows what it would pick without switching; `/route off` disables it; `/route` or `/route status` shows the mode and the last 10 decisions.
- The status line shows the model in use and why, e.g. `route: haiku (lookup)`.

## Settings (`userConfig`)

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto`, `suggest` or `off` |
| `midModel` | `sonnet` | alias or full model id |
| `smallModel` | `haiku` | alias or full model id |
| `contextLimit` | `150000` | main thread stays on its model above this many context tokens |
| `classifier` | `rules` | `rules` or `rules+model` |

## Install

Local, for one session:

```
claude --plugin-dir /path/to/model-router
```

From a GitHub repo that holds this folder with its `.claude-plugin/marketplace.json`:

```
/plugin install model-router --marketplace <owner>/<repo>
```

## Limits

- It runs inside each Claude Code session that loads it. A Claude Projects thread is its own cloud session, so threads route only where the mod is installed for that environment (for example, enabled in the repository's `.claude/settings.json`).
- It cannot pick the model a thread starts on; that is set when the thread is created. It switches per request after that.
- Switching models mid-thread skips the prompt cache for the switched turns. On long threads that can cost more than it saves, which is why the context guard exists. Use `/route suggest` for a few days to see what it would do before trusting `auto`.
- The rules are keyword heuristics tuned to lean toward top. Adjust the lists in `hooks/route.ts` per client.

## Develop

```
claude plugin validate .
claude plugin test .
```
