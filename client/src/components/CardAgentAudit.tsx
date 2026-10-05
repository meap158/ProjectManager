import { useState } from 'react';
import { api } from '../api';

export function CardAgentAudit({ cardId }: { cardId: number }) {
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof api.cardAgentAudit>> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      setEntries(await api.cardAgentAudit(cardId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="field">
      <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={busy}>
        Agent board history
      </button>
      {error && <div className="error-banner">{error}</div>}
      {entries &&
        (entries.length ? (
          <ul>
            {entries.map((entry, i) => (
              <li key={i}>
                <span className="faint">
                  {entry.created_at} · {entry.owner_kind} #{entry.owner_id}
                </span>{' '}
                {entry.action === 'update_status' ? 'Changed column' : 'Added a note'}:{' '}
                {entry.detail}
              </li>
            ))}
          </ul>
        ) : (
          <p className="faint">No agent board updates yet.</p>
        ))}
    </div>
  );
}
