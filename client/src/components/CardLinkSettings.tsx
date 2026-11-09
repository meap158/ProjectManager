import { useEffect, useState } from 'react';
import { api } from '../api';

/** Project-scoped opt-in beside the project's GitHub identity settings. */
export function CardLinkSettings({ projectId }: { projectId: number }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    api.cardLinking(projectId).then(
      (state) => {
        if (current) setEnabled(state.writeBack);
      },
      () => {
        if (current) setError('Could not load card comment settings.');
      },
    );
    return () => {
      current = false;
    };
  }, [projectId]);
  const save = async (value: boolean) => {
    setBusy(true);
    setError('');
    try {
      setEnabled((await api.setCardLinking(projectId, value)).writeBack);
    } catch {
      setError('Could not save card comment settings.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card-link-settings">
      <label className="check" style={{ minHeight: 44, whiteSpace: 'normal' }}>
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled === null || busy}
          onChange={(event) => void save(event.target.checked)}
        />
        Comment on linked GitHub issues and PRs when cards reach Review or Done
      </label>
      <p className="faint">
        Off by default. Requires an active scoped orchestrator with Git on its own and the
        repository owner's GitHub login. At most one comment per minute and ten per hour for this
        project.
      </p>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
