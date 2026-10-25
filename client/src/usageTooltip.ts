import type { ProviderLimits } from '../../shared/limits';
import { formatRelative } from './format';

export function usageTooltip(limits: ProviderLimits): string {
  return [
    `Active account: ${limits.accountEmail || limits.accountName || 'email unavailable'}`,
    limits.accountPlan ? `Plan: ${limits.accountPlan}` : null,
    `From the ${limits.source}, reported ${formatRelative(limits.asOf)}`,
  ]
    .filter(Boolean)
    .join('\n');
}
