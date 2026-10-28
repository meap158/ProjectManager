import type { ReactNode } from 'react';
import type { TypeGroup } from './folderRules';

const SYMBOLS: Record<Exclude<TypeGroup, 'folder'>, ReactNode> = {
  image: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <circle cx="5.5" cy="5.5" r="1" />
      <path d="m2 11 3.5-3.5 3 3L11 8l3 3" />
    </>
  ),
  video: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M5 2.5v11M11 2.5v11M2 6h3M2 10h3M11 6h3M11 10h3" />
    </>
  ),
  audio: (
    <>
      <path d="M6 11V4l7-1.5v7" />
      <ellipse cx="4" cy="11.5" rx="2" ry="1.5" />
      <ellipse cx="11" cy="10" rx="2" ry="1.5" />
    </>
  ),
  document: (
    <>
      <path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 7h4M6 9.5h4M6 12h3" />
    </>
  ),
  code: <path d="m5 4-4 4 4 4M11 4l4 4-4 4M9 2.5l-2 11" />,
  data: (
    <>
      <ellipse cx="8" cy="3.5" rx="5.5" ry="2" />
      <path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
    </>
  ),
  archive: (
    <>
      <rect x="1.5" y="2" width="13" height="3" rx="1" />
      <path d="M3 5v9h10V5M6 8h4" />
    </>
  ),
  other: (
    <>
      <circle cx="3" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="13" cy="8" r="1" />
    </>
  ),
};

export function FolderTypeIcon({ type }: { type: Exclude<TypeGroup, 'folder'> }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SYMBOLS[type]}
    </svg>
  );
}
