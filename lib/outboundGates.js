// Both flags are off unless explicitly set to "true": outbound email has a separate
// sole sender, and a second sender (e.g. on Render) would double-email prospects.

function scheduledJobsEnabled() {
  return process.env.ENABLE_SCHEDULED_JOBS === 'true';
}

function liveSendsEnabled() {
  return process.env.ENABLE_LIVE_SENDS === 'true';
}

const SCHEDULED_JOBS_DISABLED_REASON =
  'Scheduled jobs are disabled on this server. Set ENABLE_SCHEDULED_JOBS=true to allow live intake and dispatch.';

const LIVE_SENDS_DISABLED_REASON =
  'Live sends are disabled on this server. Set ENABLE_LIVE_SENDS=true to allow them. Dry runs still work.';

module.exports = {
  scheduledJobsEnabled,
  liveSendsEnabled,
  SCHEDULED_JOBS_DISABLED_REASON,
  LIVE_SENDS_DISABLED_REASON
};
