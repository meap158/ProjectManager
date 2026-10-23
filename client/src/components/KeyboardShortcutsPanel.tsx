import { useEffect, useRef, useState } from 'react';
import {
  SHORTCUT_ACTIONS,
  actionFor,
  comboFromEvent,
  formatCombo,
  resetAllShortcuts,
  setRecording,
  setShortcut,
  useBindings,
  validCombo,
  type ShortcutId,
} from '../shortcuts';
import './keyboard-shortcuts.css';

/**
 * Settings > Keyboard shortcuts (PM-244): every action with its key. Change records the next key
 * press (Escape cancels, Tab is never taken so the keyboard can leave), a key already in use is
 * refused, and each action can go back to its default or be left without a key.
 */
export function KeyboardShortcutsPanel({ onError }: { onError: (message: string) => void }) {
  const bindings = useBindings();
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [problem, setProblem] = useState<{ id: ShortcutId; text: string } | null>(null);
  const recorder = useRef<HTMLButtonElement>(null);
  const section = useRef<HTMLElement>(null);

  // Linked from the Agents page's shortcut help ("/settings#keyboard-shortcuts").
  // The panels above load their data after this mounts and push it down: scroll again then.
  useEffect(() => {
    if (window.location.hash !== '#keyboard-shortcuts') return;
    const scroll = () => section.current?.scrollIntoView?.();
    scroll();
    const timers = [setTimeout(scroll, 600), setTimeout(scroll, 1500)];
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    setRecording(recordingId !== null);
    if (recordingId) recorder.current?.focus();
    return () => setRecording(false);
  }, [recordingId]);

  const save = (id: ShortcutId, combo: string | null | undefined) =>
    setShortcut(id, combo).catch((e: Error) => onError(e.message));

  const onRecordKey = (id: ShortcutId, e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      setRecordingId(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecordingId(null);
      return;
    }
    const combo = comboFromEvent(e.nativeEvent);
    if (!combo) return; // A modifier on its own: keep listening.
    if (!validCombo(combo)) {
      setProblem({ id, text: `${formatCombo(combo)} can't be used` });
      return;
    }
    const other = actionFor(combo, bindings);
    if (other && other.id !== id) {
      setProblem({ id, text: `${formatCombo(combo)} is already used by “${other.label}”` });
      return;
    }
    setProblem(null);
    setRecordingId(null);
    void save(id, combo);
  };

  const groups = [...new Set(SHORTCUT_ACTIONS.map((a) => a.group))];
  const changed = SHORTCUT_ACTIONS.some((a) => bindings[a.id] !== a.default);

  return (
    <section
      ref={section}
      className="panel"
      id="keyboard-shortcuts"
      aria-label="Keyboard shortcuts"
    >
      <div className="panel-header">
        <h2>Keyboard shortcuts</h2>
        {changed && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setProblem(null);
              resetAllShortcuts().catch((e: Error) => onError(e.message));
            }}
          >
            Reset all
          </button>
        )}
      </div>
      <p className="faint shortcuts-intro">
        Act on the selected item without the mouse; the key also shows in each button&rsquo;s
        tooltip. Keys with Ctrl, Alt or ⌘ also work while its terminal has focus; other keys only
        work outside text fields and terminals.
      </p>
      {groups.map((group) => (
        <div key={group} className="shortcuts-group">
          <h3 className="shortcuts-group-title">{group}</h3>
          <ul className="list">
            {SHORTCUT_ACTIONS.filter((a) => a.group === group).map((a) => {
              const combo = bindings[a.id];
              const recording = recordingId === a.id;
              return (
                <li key={a.id} className="shortcut-row">
                  <span className="shortcut-label">{a.label}</span>
                  {recording ? (
                    <button
                      ref={recorder}
                      type="button"
                      className="btn btn-sm shortcut-recorder"
                      aria-label={`Press the new keys for ${a.label}, or Escape to cancel`}
                      onKeyDown={(e) => onRecordKey(a.id, e)}
                      onBlur={() => setRecordingId(null)}
                    >
                      Press keys… (Esc cancels)
                    </button>
                  ) : (
                    <span className="shortcut-keys">
                      {combo ? (
                        <kbd>{formatCombo(combo)}</kbd>
                      ) : (
                        <span className="faint">None</span>
                      )}
                    </span>
                  )}
                  <span className="actions shortcut-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`Change the shortcut for ${a.label}`}
                      onClick={() => {
                        setProblem(null);
                        setRecordingId(a.id);
                      }}
                    >
                      Change
                    </button>
                    {combo !== a.default && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Reset the shortcut for ${a.label} to ${formatCombo(a.default)}`}
                        title={`Back to ${formatCombo(a.default)}`}
                        onClick={() => {
                          const other = actionFor(a.default, bindings);
                          if (other && other.id !== a.id) {
                            setProblem({
                              id: a.id,
                              text: `${formatCombo(a.default)} is in use by “${other.label}”`,
                            });
                            return;
                          }
                          setProblem(null);
                          void save(a.id, undefined);
                        }}
                      >
                        Reset
                      </button>
                    )}
                    {combo && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Remove the shortcut for ${a.label}`}
                        onClick={() => {
                          setProblem(null);
                          void save(a.id, null);
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </span>
                  {problem?.id === a.id && (
                    <span className="shortcut-problem" role="alert">
                      {problem.text}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
