import { Link } from 'react-router';
import type { OrchestratorProviderBlocker } from '../../../shared/orchestrator';

/** Each provider can require a different correction in a mixed-blocker decision. */
export function OrchestratorProviderRecovery({
  blocker,
}: {
  blocker: OrchestratorProviderBlocker;
}) {
  const action =
    blocker.code === 'unavailable'
      ? { href: '/settings', label: 'Agent settings' }
      : blocker.code === 'capacity'
        ? { href: '/agents', label: 'View workers' }
        : blocker.code === 'quota_unknown' || blocker.code === 'quota_reserve'
          ? { href: '/agents', label: 'View usage' }
          : null;
  return (
    <>
      {blocker.detail}
      {action && (
        <>
          {' '}
          <Link to={action.href}>{action.label}</Link>
        </>
      )}
    </>
  );
}
