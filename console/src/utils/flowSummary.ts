// Moved out of FlowDiagram.tsx so the reactflow-heavy flow page can be code-split
// (perf fix P9) while the always-loaded FlowHeader keeps using this pure helper.

// Helper function to calculate flow summary statistics
export const calculateFlowSummary = (invocations: any[]) => {
  let totalInvocations = 0;
  let totalEvents = 0;
  let detectedEvents = 0;
  let undetectedEvents = 0;
  let totalJobs = 0;
  let successfulJobs = 0;
  let failedJobs = 0;
  let runningJobs = 0;

  invocations.forEach(invocation => {
    totalInvocations++;
    const events = invocation.event_executions || [];

    events.forEach((event: any) => {
      totalEvents++;
      if (event.detected) {
        detectedEvents++;
      } else {
        undetectedEvents++;
      }

      const jobs = event.job_executions || [];
      jobs.forEach((job: any) => {
        totalJobs++;
        switch (job.status) {
          case 'completed':
            successfulJobs++;
            break;
          case 'failed':
            failedJobs++;
            break;
          case 'running':
            runningJobs++;
            break;
          default:
            successfulJobs++; // Default to successful for unknown statuses
        }
      });
    });
  });

  return {
    totalInvocations,
    totalEvents,
    detectedEvents,
    undetectedEvents,
    totalJobs,
    successfulJobs,
    failedJobs,
    runningJobs
  };
};

