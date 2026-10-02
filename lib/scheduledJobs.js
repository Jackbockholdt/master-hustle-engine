// Off unless explicitly enabled: outbound email has a separate sole sender, and a
// second scheduler (e.g. on Render) would double-email prospects.
function scheduledJobsEnabled() {
  return process.env.ENABLE_SCHEDULED_JOBS === 'true';
}

const SCHEDULED_JOBS_DISABLED_REASON =
  'Scheduled jobs are disabled on this server. Set ENABLE_SCHEDULED_JOBS=true to allow live intake and dispatch.';

module.exports = { scheduledJobsEnabled, SCHEDULED_JOBS_DISABLED_REASON };
