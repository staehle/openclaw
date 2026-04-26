# Context Warnings & Critical Thresholds

## Problem

1. **`notifyUser` is broken.** The config option `agents.defaults.compaction.notifyUser: true` exists and the code to send `🧹 Compacting context...` / `🧹 Compaction complete` messages is wired up — but it never fires. The notification path listens for `onAgentEvent({ stream: "compaction" })` events, but the actual compaction always goes through the **overflow-recovery path** in `run.ts`, which calls `contextEngine.compact()` directly without emitting stream events. The Pi agent's internal auto-compaction (which *does* emit those events) appears to never trigger because OpenClaw's overflow detection preempts it.

2. **No proactive context warnings.** There's no way to know context is getting full until compaction (or a forced `/compact`) happens. By then, context is already summarized and detail is lost.

3. **No way to disable auto-compaction.** `compaction.mode` only accepts `"default"` or `"safeguard"`. There's no `"off"` option. Users who want manual control over compaction timing have no recourse.

## Goals

- **Fix `notifyUser`** so compaction notices actually reach the user on all code paths
- **Add context milestone warnings** at configurable thresholds (e.g. 50%, 75%, 90%)
- **Add `contextCritical` behavior** when context reaches 95%+ — a last-resort system message before compaction is unavoidable
- **Optionally allow disabling auto-compaction** (`mode: "off"`) so the user can rely on manual `/compact` and milestone warnings instead

## Architecture

### Where context usage is tracked

After each agent turn, the Pi embedded runner has access to:
- `contextTokens` — tokens used in the current context
- `contextWindow` — model's total context window
- `reserveTokens` — headroom reserved for generation

The usage ratio is: `contextTokens / contextWindow`

The existing compaction threshold check is in `run.ts` (overflow recovery) and `run/attempt.ts` (preemptive compaction check). Both fire AFTER context has already exceeded the threshold.

### Proposed changes

#### 1. Fix `notifyUser` (bug fix)

**File:** `src/agents/pi-embedded-runner/run.ts` (overflow recovery path, ~line 1150)

The overflow recovery path calls `contextEngine.compact()` and logs success, but never emits the stream event. Fix: emit `onAgentEvent({ stream: "compaction", data: { phase: "start" } })` before calling compact, and `onAgentEvent({ stream: "compaction", data: { phase: "end", completed: true } })` after.

This is the minimal fix — makes `notifyUser: true` actually work.

Alternatively, the notification code could be duplicated/extracted so it doesn't depend on stream events. But emitting the events is cleaner — it also fixes hook delivery for `session:compact:before` and `session:compact:after` on the overflow path.

#### 2. Add context milestone warnings (new feature)

**Config:** `agents.defaults.contextWarnings`

```jsonc
{
  "agents": {
    "defaults": {
      "contextWarnings": {
        "enabled": true,
        "milestones": [0.50, 0.75, 0.90],
        "notifyUser": true,     // send visible message to chat
        "notifyAgent": true,    // inject system event so agent can save state
        "criticalThreshold": 0.95,
        "criticalAction": "warn"  // "warn" | "compact" | "reset"
      }
    }
  }
}
```

**Milestone warning flow:**

1. After each agent turn completes (in `run.ts` or `attempt.ts`), check `contextTokens / contextWindow` against configured milestones
2. Track which milestones have been crossed for this session (in the session store entry, e.g. `contextWarningsFired: [0.5, 0.75]`)
3. When a new milestone is crossed:
   - If `notifyUser`: send a visible message via `onBlockReply` (like compaction notice)
   - If `notifyAgent`: inject a system event into the session telling the agent to save important state to memory files
4. Don't re-fire a milestone that's already been fired for this session
5. Reset milestone tracking on `/new`, `/reset`, or session reset

**Where to hook in:**

The best insertion point is in `src/agents/pi-embedded-runner/run/attempt.ts` after a successful prompt completion, where `contextTokens` is available from the usage report. This is where the existing threshold maintenance check runs (post-turn compaction).

Alternatively, hook into the post-run logic in `run.ts` around where `autoCompactionCount` is checked.

**Message format examples:**

```
⚠️ Context at 50% (100K / 200K tokens) — consider saving important state to memory
⚠️ Context at 75% (150K / 200K tokens) — approaching limit, save critical context now
⚠️ Context at 90% (180K / 200K tokens) — near capacity, compaction imminent
```

#### 3. Critical threshold behavior (`contextCritical`)

When context usage crosses `criticalThreshold` (default 95%):

**`criticalAction: "warn"` (default):**
- Send an urgent user-visible warning
- Inject a system event telling the agent: "Context is critically full. Save ALL important state to memory files immediately. The next turn may trigger compaction."
- Let the agent respond and save state before the next message triggers overflow

**`criticalAction: "compact"`:**
- Same warnings as above
- Then auto-compact (current behavior, but with notice)

**`criticalAction: "reset"`:**
- Same warnings as above
- Then start a new session (nuclear option — saves nothing that wasn't already persisted)

The "warn" mode is the most useful — it gives the agent one last chance to save context before compaction eats it.

#### 4. Optional `mode: "off"` for auto-compaction

Add `"off"` to `AgentCompactionMode`. When set:
- Disable preemptive compaction checks in `run/attempt.ts`
- Disable overflow recovery compaction in `run.ts`
- Still allow manual `/compact`
- If a true overflow error comes from the provider (context literally too large), return an error message to the user instead of silently compacting

This pairs with milestone warnings: the user sees warnings at 75%/90% and can manually `/compact` or `/new` when ready.

**Risk:** If the user ignores all warnings AND context truly exceeds the model's window, the provider will reject the request. We need a graceful error message in that case: "Context exceeded model limit. Use `/compact` to summarize history or `/new` to start fresh."

## Implementation Plan

### Phase 1: Fix `notifyUser` (minimal, safe)
- Emit compaction stream events from the overflow recovery path in `run.ts`
- Test: trigger a compaction, verify `🧹` messages appear in chat
- Files: `src/agents/pi-embedded-runner/run.ts`

### Phase 2: Context milestone warnings
- Add config schema for `contextWarnings`
- Add milestone tracking to session store
- Add post-turn context check in `run/attempt.ts`
- Add message delivery for milestone warnings
- Files:
  - `src/config/types.agent-defaults.ts` (types)
  - `src/config/zod-schema.agent-defaults.ts` (validation)
  - `src/config/schema.base.generated.ts` (schema)
  - `src/config/schema.labels.ts` + `schema.help.ts` (docs)
  - `src/agents/pi-embedded-runner/run/attempt.ts` (check logic)
  - `src/agents/pi-embedded-runner/run.ts` (alternative hook point)
  - `src/auto-reply/reply/agent-runner-execution.ts` (delivery)

### Phase 3: Critical threshold
- Add `criticalThreshold` + `criticalAction` to config
- Implement critical warning with forced memory flush
- Files: same as Phase 2 + `src/agents/pi-embedded-runner/compact.ts`

### Phase 4: Optional `mode: "off"`
- Add `"off"` to `AgentCompactionMode`
- Guard preemptive + overflow compaction behind mode check
- Add graceful error for true overflows when compaction is off
- Files: `src/config/types.agent-defaults.ts`, `run.ts`, `run/attempt.ts`

## Open Questions

1. **Should milestone warnings be injected as system events or user-visible messages?** System events affect the agent's behavior but aren't visible to the user. User-visible messages inform the user but add noise. Probably both (configurable).

2. **Should critical threshold trigger a memory flush?** The existing `memoryFlush.softThresholdTokens` already does this at a soft threshold. Critical threshold could trigger a *second* flush if the soft one didn't fire, or if context grew past it in a single turn.

3. **Token counting accuracy.** Context token counts are estimates — they can be off by 5-10%. Milestones should have some hysteresis to avoid re-firing after a brief dip.

4. **Per-session vs per-agent config?** Start with agent-level defaults. Per-session overrides can come later.
