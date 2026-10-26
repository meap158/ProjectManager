import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { ConfirmDelete } from './ConfirmDelete';

// Settings > SOPs, edit mode (PM-316): the SOP file as YAML. Saving validates on the server and
// refuses a file with a problem (naming its line), so the audit never runs on a broken set. Your
// copy lives in the data folder; "Reset to defaults" goes back to the shipped set.

export function SopsEditor({ onDone }: { onDone: (saved: boolean) => void }) {
  const [yaml, setYaml] = useState<string | null>(null);
  const [original, setOriginal] = useState('');
  const [custom, setCustom] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textId = useId();

  useEffect(() => {
    api.sopsFile().then(
      (f) => {
        setYaml(f.yaml);
        setOriginal(f.yaml);
        setCustom(f.custom);
        setFile(f.path);
      },
      (e: Error) => setProblem(e.message),
    );
  }, []);

  const save = async () => {
    if (yaml === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.saveSopsFile(yaml);
      onDone(true);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel sop-editor" aria-label="Edit SOPs">
      <div className="panel-header">
        <h2>Edit SOPs</h2>
        <span className="meta">{custom ? 'Your edited copy' : 'The defaults'}</span>
      </div>
      <p className="faint sop-intro">
        Each SOP has its text and a list of read-only checks; the comments at the top of the file
        list every check kind. Saving makes your own copy
        {file ? (
          <>
            {' '}
            at <code>{file}</code>
          </>
        ) : null}
        , checked before it is used. Keep ids stable: waivers are stored by id.
      </p>
      {problem && (
        <div className="error-banner" role="alert">
          {problem}
        </div>
      )}
      <label className="sr-only" htmlFor={textId}>
        SOP file (YAML)
      </label>
      {yaml === null ? (
        <div className="skeleton" style={{ height: 320 }} />
      ) : (
        <textarea
          id={textId}
          className="textarea sop-yaml"
          value={yaml}
          spellCheck={false}
          rows={24}
          onChange={(e) => setYaml(e.target.value)}
          onKeyDown={(e) => {
            // Tab indents (YAML is all indentation); Shift+Tab or Esc then Tab leaves the field.
            if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              const t = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = t;
              setYaml(`${t.value.slice(0, a)}  ${t.value.slice(b)}`);
              requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
            }
          }}
        />
      )}
      <div className="sop-editor-actions">
        {custom ? (
          <ConfirmDelete
            label="Reset to defaults"
            text="Reset to defaults"
            heading="Reset the SOPs to the defaults?"
            message="This removes your edited copy and goes back to the SOPs shipped with ProjectManager. Waivers are kept."
            confirmLabel="Reset"
            icon={null}
            small
            onConfirm={async () => {
              await api.resetSopsFile();
              onDone(true);
            }}
          />
        ) : (
          <span />
        )}
        <div className="actions">
          <button type="button" className="btn btn-sm" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || yaml === null || yaml === original}
            onClick={() => void save()}
          >
            {busy ? 'Checking…' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  );
}
