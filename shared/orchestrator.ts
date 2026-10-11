export interface OrchestratorConfig {
  id: string;
  name: string;
  enabled: boolean;
  strategy?: 'observe' | 'autonomous';
  followDashboardAttention?: boolean;
  pruneDashboardAttention?: boolean;
  projectIds: number[];
  providers: string[];
  maxWorkers: number;
  maxWorkersPerProject: number;
  maxWorkersPerProvider: number;
  reservePercent: number;
  allowUnknownQuota: boolean;
  quotaMaxAgeMs: number;
}
export interface OrchestratorEvent {
  at: string;
  orchestratorId: string;
  cardId?: number;
  runId?: number;
  action: string;
  message: string;
  count?: number;
}

export type OrchestratorWaitReason =
  | 'active_worker'
  | 'review_required'
  | 'assignment_reserved'
  | 'retry_cooldown'
  | 'retry_budget_exhausted'
  | 'project_capacity'
  | 'managed_capacity'
  | 'global_capacity'
  | 'provider_capacity'
  | 'quota_exceeded'
  | 'quota_unknown'
  | 'no_provider_available';

export interface OrchestratorExecutionStatus {
  executing: boolean;
  lastTickAt: string | null;
}

export interface OrchestratorPlanDecision {
  cardId: number;
  projectId: number;
  action: 'dispatch' | 'review' | 'wait';
  providerId?: string;
  reason: string;
  waitReason?: OrchestratorWaitReason;
  occupancy?: {
    managedWorkers: number;
    externalWorkers: number;
    projectWorkers: number;
  };
  retry?: {
    attemptsUsed: number;
    attemptsRemaining: number;
    retryAt: string | null;
    blocker: string | null;
  };
  execution?: {
    autonomy: 'edit' | 'read';
    supervisorAttempts: number;
    requiresReview: boolean;
  };
  providerBlockers?: { providerId: string; detail: string }[];
}

export interface OrchestratorState {
  instances: OrchestratorConfig[];
  events: OrchestratorEvent[];
  status?: OrchestratorExecutionStatus;
}
