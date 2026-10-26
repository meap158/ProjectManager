import { useState, type MutableRefObject } from 'react';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { ConfirmDelete } from './ConfirmDelete';
import { SessionContinue } from './SessionContinue';
import { SessionImageButton } from './SessionImageButton';
import { SessionProgress } from './SessionProgress';

// A session terminal's own actions, the same wherever its pane is shown: the global Agents
// workspace (grid and docked list) and a project's Agents tab. One component, so the two headers
// cannot drift apart again (the project's lacked Continue and "→ Review").
//
//   → Review   the linked card, once the work looks done
//   progress   what the CLI reports it is doing
//   image      attach a picture to the terminal (the chat view has its own)
//   continue   type "continue" into a CLI that stopped to wait
//   restart / stop / start, and dispose for an ended one-time task session
//
// The caller wraps it (its own layout and the ⋯ overflow on phones).

export function SessionPaneActions({
  session: s,
  view,
  pasteRef,
  showProgress = true,
  showContinue = true,
  onChanged,
  onDeleted,
  onError,
}: {
  session: AgentSession;
  /** The pane's current view: in the chat, the composer has the image and continue actions. */
  view: 'chat' | 'terminal';
  pasteRef: MutableRefObject<((text: string) => void) | null>;
  /** False where the list row already shows the progress. */
  showProgress?: boolean;
  /** False while the list shows ended sessions only. */
  showContinue?: boolean;
  onChanged: (session: AgentSession) => void;
  /** Given where an ended task session may be disposed from the pane. */
  onDeleted?: (id: number) => void;
  onError: (message: string) => void;
}) {
  const running = s.status === 'running';
  const [restarting, setRestarting] = useState(false);
  const [cardNote, setCardNote] = useState<string | null>(null);
  const restartBusy = restarting || (!!s.restartProgress && s.restartProgress !== 'failed');

  const act = async (fn: () => Promise<AgentSession>) => {
    try {
      onChanged(await fn());
    } catch (e) {
      onError((e as Error).message);
    }
  };

  /** Hand the linked card on to Review once the work in this session looks done. */
  const sendCardToReview = async () => {
    if (!s.cardId) return;
    try {
      await api.updateCard(s.cardId, { status: 'review' });
      setCardNote(`${s.cardKey} → Review`);
      setTimeout(() => setCardNote(null), 2500);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <>
      {cardNote && (
        <span className="badge badge-live" role="status">
          {cardNote}
        </span>
      )}
      {s.cardId && !cardNote && (
        <button
          type="button"
          className="icon-btn icon-btn-text"
          title={`Move ${s.cardKey} to Review`}
          onClick={() => void sendCardToReview()}
        >
          → Review
        </button>
      )}
      {showProgress && s.terminal === 'pty' && <SessionProgress session={s} />}
      {running && s.terminal === 'pty' && view !== 'chat' && (
        <SessionImageButton sessionId={s.id} pasteRef={pasteRef} onError={onError} />
      )}
      {showContinue && view !== 'chat' && (
        <SessionContinue session={s} onError={onError} iconOnly />
      )}
      {running ? (
        <>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Restart ${s.name}`}
            title="Restart session (stop, then start)"
            disabled={restartBusy}
            onClick={async () => {
              setRestarting(true);
              try {
                await act(() => api.restartSession(s.id));
              } finally {
                setRestarting(false);
              }
            }}
          >
            {restarting ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M20 7v5h-5M20 12a8 8 0 1 0-2 6M20 7l-2 2" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Stop session"
            title="Stop session"
            disabled={restarting}
            onClick={() => void act(() => api.stopSession(s.id))}
          >
            ■
          </button>
        </>
      ) : (
        <button
          type="button"
          className="icon-btn"
          aria-label="Start session"
          title="Start session"
          onClick={() => void act(() => api.startSession(s.id))}
        >
          ▶
        </button>
      )}
      {!running && s.cardId && !s.supervise && onDeleted && (
        <ConfirmDelete
          small
          label={`Dispose ${s.name}`}
          heading={`Dispose task session ${s.name}?`}
          message="This removes the ended session and its recorded output. The linked task stays on the board."
          confirmLabel="Dispose session"
          onConfirm={() => onDeleted(s.id)}
        />
      )}
    </>
  );
}
