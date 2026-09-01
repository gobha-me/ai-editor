# Approved Automation Contract

**Status:** Implemented for one approved script invocation.

The model may propose a script only when the active profile admits the script
tool. The script is displayed in an approval card and runs only after explicit
user approval through `js/intelligence/script-runner.js` and the dedicated
worker.

## Boundary

- Proposal is not execution. Rejection and cancellation produce visible terminal
  states and no hidden retry.
- Each invocation receives explicit timeout, output, and capability limits.
- The worker is an isolation and accidental-failure boundary, not a claim that
  arbitrary hostile JavaScript is safe.
- Results distinguish completion, timeout, cancellation, worker failure, and
  output truncation.
- The main page owns approval and lifecycle state; worker messages are correlated
  to the active invocation.
- Profile or plan-mode denial occurs before a worker is created.

There is no persistent user-authored automation marketplace, background daemon,
or unattended scheduling contract. Tests cover profile admission, approval-card
state, worker messages, limits, cancellation, and failure reporting.
