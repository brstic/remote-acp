# Threat model (v1)

Assets: user files outside the chosen workspace, provider credentials, the ability to run code on the machine, prompts/results, the user's provider quota.

| Threat | Mitigation | Test |
|---|---|---|
| Malicious site claims another brand in a link | Identity comes from relay registry; link carries only an opaque ticket; unverified services flagged | `pairing_ticket_single_use_and_expiry_and_brand` |
| Reused/expired ticket | single use, bound to first desktop, TTL | same + `expired_ticket_is_rejected` |
| Wrong service/tenant/user | ownership + external user binding on relay; independent desktop check | `tenant_and_user_isolation`, `grant_authorization` |
| Replay/reorder/duplicate | per-task sequences, dedupe, at-most-once dispatch, idempotency keys | `reconnect_mid_task_without_duplicates`, `idempotency_and_single_active_task` |
| Prompt asks for ~/.ssh, /etc, parent dirs | fs confinement + denylist; restricted agent mode | `workspace_confinement_and_redaction`, policy unit tests |
| Symlink / hard-link escape | canonicalization, nlink check | `symlink_escape_denied`, `hardlink_denied` |
| Website approves its own permission prompt | no API exists; permissions answered only in desktop UI | `permission_allow_and_deny_are_local_only` |
| Frame flood / huge payload | size limits, bounded channels, backpressure, rate limits | `rejects_oversized_prompt_and_frame`, `flood_with_slow_consumer_backpressure` |
| Network loss mid-task | resend in-flight frame, relay grace, desktop cancels if relay unreachable 60 s | `reconnect_mid_task_without_duplicates`, `desktop_offline_task_fails_fast` |
| Revoke mid-task | immediate cancel both sides | `revoke_from_desktop_…`, `revoke_from_service_…` |
| Adapter/agent crash | pending requests failed, task failed, fresh agent next time | `crash_fails_pending_and_reports_exit`, `agent_crash_reports_failure_and_recovers` |
| Adapter changed on disk | integrity pin + entry hash re-verified per launch | manual (see PROGRESS) |
| Token leakage in logs | token-like redaction, no prompt logging on relay, account notifications dropped | `codex_through_bridge` (no `@`), redaction tests |

Not yet addressed: E2EE (relay can read prompts in memory), OS-level sandbox beyond the agent's own mode, Windows job-object process trees, code signing/notarization.
