import { PreviewWorkspace } from '../components/ProjectPreview';

// Global Preview (PM-253): every app running on this computer, from any project, plus quick
// launches. Not a project tab: a dev server is not owned by one project. Full width and no
// visible header, so the viewer gets the screen; the heading stays for screen readers.
export function PreviewPage() {
  return (
    <main className="page page-wide preview-page">
      <h1 className="sr-only">Preview</h1>
      <PreviewWorkspace />
    </main>
  );
}
