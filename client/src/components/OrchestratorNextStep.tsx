import { Link } from 'react-router';
import type {
  OrchestratorPlanDecision,
  OrchestratorWaitReason,
} from '../../../shared/orchestrator';

const steps: Record<
  OrchestratorWaitReason,
  { text: string; label: string; target: 'workers' | 'usage' | 'settings' | 'card' }
> = {
  active_worker: {
    text: 'Inspect the assigned worker before starting more work.',
    label: 'View workers',
    target: 'workers',
  },
  review_required: {
    text: 'Review the finished run and accept or reject its changes.',
    label: 'Review runs',
    target: 'workers',
  },
  assignment_reserved: {
    text: 'Inspect the reservation and worker state; another check will reconcile it.',
    label: 'View workers',
    target: 'workers',
  },
  retry_cooldown: {
    text: 'Wait until the cooldown ends, then check the queue again.',
    label: 'Open task',
    target: 'card',
  },
  retry_budget_exhausted: {
    text: 'Inspect failed runs and correct the cause before requesting more work.',
    label: 'Inspect runs',
    target: 'workers',
  },
  project_capacity: {
    text: 'Wait for a project worker to finish, or inspect its progress.',
    label: 'View workers',
    target: 'workers',
  },
  managed_capacity: {
    text: 'Wait for a scoped worker to finish before starting another.',
    label: 'View workers',
    target: 'workers',
  },
  global_capacity: {
    text: 'The machine worker limit includes other projects. Inspect active work.',
    label: 'View all agents',
    target: 'usage',
  },
  provider_capacity: {
    text: 'Wait for a worker using this provider to finish.',
    label: 'View all agents',
    target: 'usage',
  },
  quota_exceeded: {
    text: 'Check provider usage; after renewal, check the queue to verify quota again.',
    label: 'View usage',
    target: 'usage',
  },
  quota_unknown: {
    text: 'Obtain a fresh provider usage report, then check the queue again.',
    label: 'View usage',
    target: 'usage',
  },
  no_provider_available: {
    text: 'Check the configured CLI installation and PATH on this machine.',
    label: 'Agent settings',
    target: 'settings',
  },
};

export function OrchestratorNextStep({ decision }: { decision: OrchestratorPlanDecision }) {
  if (decision.action === 'dispatch' || !decision.waitReason) return null;
  const step =
    decision.waitReason === 'active_worker' && decision.worker?.executionState === 'unknown'
      ? {
          text: 'Execution ownership is unknown. Check the worker and connection; resolve it from run details only after independently verifying it has stopped.',
          label: 'Inspect unknown execution',
          target: 'workers' as const,
        }
      : decision.waitReason === 'retry_cooldown' && decision.worker
        ? {
            text: 'Inspect the failed run during the cooldown and correct its cause before the next attempt. Checking again does not bypass the cooldown.',
            label: 'Inspect failed run',
            target: 'workers' as const,
          }
        : steps[decision.waitReason];
  if (!step) return null;
  const href =
    step.target === 'workers'
      ? decision.worker?.orchestratorId
        ? `/orchestrators?orchestrator=${decision.worker.orchestratorId}&run=${decision.worker.runId}#orchestrator-runs-${decision.worker.orchestratorId}`
        : `/projects/${decision.projectId}?tab=agents`
      : step.target === 'card'
        ? `/board?project=${decision.projectId}&card=${decision.cardId}`
        : step.target === 'settings'
          ? '/settings'
          : '/agents';
  return (
    <span className="faint" style={{ flexBasis: '100%', fontSize: 12 }}>
      {step.text} <Link to={href}>{step.label}</Link>
    </span>
  );
}
