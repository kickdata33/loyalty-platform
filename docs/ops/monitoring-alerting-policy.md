# GCP-Native Monitoring & Alerting Policy

Source of truth: `FINAL-ARCHITECTURE.md` §30 (Monitoring/Error Strategy) and §38.2 (Phase 10
Blocker 2, Locked — Option C, half (a)).

**Scope note (§38.2, locked):** this is infrastructure configuration, not application code — it
is the GCP-native half of the two-half monitoring design. The in-app half (critical
business-state-error audit trail) is implemented in code (`src/modules/ops-alert/service.ts`) and
is NOT what this document covers. Provisioning the policy below against a real GCP project is an
out-of-session operations action.

**This policy is currently the ONLY live-alerting mechanism.** Per §38.2's addendum (Option B,
locked), the in-app half's live LINE delivery was found to be non-functional (every LINE channel
in this architecture is per-merchant, §19/§20 — there is no platform-level channel to deliver a
platform-wide alert through) and has been removed; `reportCriticalError()` now only records to
`criticalErrors`, it does not deliver anything live. Until a platform-level LINE channel
architecture is separately approved, this GCP-native policy is what actually pages a human.

## What this watches

1. **Cloud Functions error rate** — any function in this codebase (`onStaffUserWrite`,
   `onEventCreate`, `dailyAutomationBatch`, `systemHealthSelfCheck`, `balanceReconciliationJob`)
   exceeding a sustained error rate.
2. **Scheduled job failure** — `dailyAutomationBatch`, `systemHealthSelfCheck`, and
   `balanceReconciliationJob` each failing to complete an execution (Cloud Functions v2 scheduled
   functions emit an `execution_count` metric with a `status` label).

Both are already indirectly observable in-app via `systemHealth/Scheduler` (§30, §37) and via
`criticalErrors` (§38.2) when a scheduled job's own top-level catch fires — this policy is the
platform-level backstop that doesn't depend on the app's own code having run successfully at all
(e.g. it still fires if the function crashes before reaching its own catch block, or if Cloud
Functions itself fails to invoke the function on schedule).

## Recommended policy definition (Cloud Monitoring, Terraform-style)

```hcl
resource "google_monitoring_alert_policy" "cloud_functions_error_rate" {
  display_name = "loyalty-platform: Cloud Functions error rate"
  combiner      = "OR"

  conditions {
    display_name = "Function execution errors > 5% over 15m"
    condition_threshold {
      filter          = "resource.type=\"cloud_function\" AND metric.type=\"cloudfunctions.googleapis.com/function/execution_count\" AND metric.label.status!=\"ok\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.05
      duration        = "900s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.ops_email.id]
}

resource "google_monitoring_alert_policy" "scheduled_job_missed" {
  display_name = "loyalty-platform: scheduled job did not run"
  combiner      = "OR"

  conditions {
    display_name = "dailyAutomationBatch / systemHealthSelfCheck / balanceReconciliationJob missing execution"
    condition_absent {
      filter   = "resource.type=\"cloud_function\" AND resource.label.function_name=(\"dailyAutomationBatch\" OR \"systemHealthSelfCheck\" OR \"balanceReconciliationJob\")"
      duration = "5400s" # 1.5x the 24h/15m schedules' own slack
    }
  }

  notification_channels = [google_monitoring_notification_channel.ops_email.id]
}

resource "google_monitoring_notification_channel" "ops_email" {
  display_name = "Loyalty Platform Ops"
  type         = "email"
  labels = {
    email_address = "REPLACE_WITH_REAL_OPS_EMAIL" # placeholder — no real address committed here
  }
}
```

## Provisioning steps (out-of-session)

1. Confirm the target GCP project id and the real ops notification email/Slack/PagerDuty
   integration to use in place of the placeholder above.
2. Apply via Terraform (`terraform apply`) or the equivalent `gcloud alpha monitoring
   policies create` / Cloud Console steps.
3. Send a test alert (e.g. temporarily lower the threshold, or use `gcloud monitoring
   channels verify`) to confirm delivery.
4. Record completion in `docs/ops/backup-restore-runbook.md`'s sibling ops log (or a new
   `docs/ops/monitoring-provisioning-log.md` if preferred) once done.
