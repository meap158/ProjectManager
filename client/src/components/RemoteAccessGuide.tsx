import { useRef, type ReactNode } from 'react';
import { InfoIcon } from './icons';

// Settings > Remote access, the (i) beside its heading (PM-327): where each Cloudflare detail the
// form asks for comes from, with links to the dashboard and Cloudflare's own documentation. The
// full setup is docs/REMOTE-ACCESS.md; this follows it. No values of anyone's own are shown here.

const DASHBOARD = 'https://one.dash.cloudflare.com/';
const DOCS = {
  tunnel: 'https://developers.cloudflare.com/tunnel/setup',
  routes: 'https://developers.cloudflare.com/tunnel/routing',
  accessApp:
    'https://developers.cloudflare.com/learning-paths/clientless-access/access-application/create-access-app/',
  mfa: 'https://developers.cloudflare.com/cloudflare-one/policies/access/mfa-requirements/',
  teamName: 'https://developers.cloudflare.com/cloudflare-one/faq/getting-started-faq/',
  aud: 'https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/',
};

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function RemoteAccessGuide({ port }: { port: number | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        className="icon-btn remote-guide-btn"
        title="Where each Cloudflare detail comes from"
        aria-label="Where each Cloudflare detail comes from"
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        <InfoIcon size={14} />
      </button>
      <dialog
        ref={dialog}
        className="confirm-dialog remote-guide"
        aria-labelledby="remote-guide-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="dialog-body">
          <h2 id="remote-guide-title">Getting the Cloudflare details</h2>
          <p className="faint">
            Everything below is in your Cloudflare account, in the{' '}
            <Ext href={DASHBOARD}>Zero Trust dashboard</Ext>. Cloudflare renames menus now and then;
            the linked pages have the current paths. The full setup is in docs/REMOTE-ACCESS.md.
          </p>

          <h3>Before the form</h3>
          <ol className="remote-guide-steps">
            <li>
              <strong>A tunnel.</strong> Networks › Connectors › Cloudflare Tunnels › Create a
              tunnel, or with <code>cloudflared tunnel create</code>. Add a route of type{' '}
              <em>Published application</em>: your hostname (say <code>pm.example.com</code>),
              service <code>http://127.0.0.1:{port ?? '<port>'}</code>.{' '}
              <Ext href={DOCS.tunnel}>Tunnel setup</Ext> · <Ext href={DOCS.routes}>Routes</Ext>
            </li>
            <li>
              <strong>An Access application</strong> for that hostname: Access controls ›
              Applications › Add an application › Self-hosted. Policy: <em>Allow</em> only your
              email(s) and <em>Require</em> multi-factor authentication; keep sessions short.{' '}
              <Ext href={DOCS.accessApp}>Create an Access application</Ext> ·{' '}
              <Ext href={DOCS.mfa}>Require MFA</Ext>
            </li>
          </ol>

          <h3>The fields</h3>
          <dl className="remote-guide-fields">
            <dt>Team name</dt>
            <dd>
              Zero Trust › Settings shows your team domain,{' '}
              <code>&lt;team&gt;.cloudflareaccess.com</code>. Enter only the part before{' '}
              <code>.cloudflareaccess.com</code>. <Ext href={DOCS.teamName}>Where to find it</Ext>
            </dd>
            <dt>Public hostname</dt>
            <dd>
              The hostname of the tunnel route above, without <code>https://</code> (for example{' '}
              <code>pm.example.com</code>). It must match the Access application&apos;s hostname.
            </dd>
            <dt>Application AUD tag</dt>
            <dd>
              Access controls › Applications › your application › Configure › Additional settings ›
              Application Audience (AUD) Tag. It stays the same unless the application is deleted
              and recreated. <Ext href={DOCS.aud}>About the AUD tag</Ext>
            </dd>
            <dt>Allowed emails</dt>
            <dd>
              The same email(s) your Access policy allows, one per line. ProjectManager checks the
              email in Cloudflare&apos;s signed token against this list as a second gate.
            </dd>
          </dl>

          <h3>Then</h3>
          <p>
            Save the details, set up the authenticator app (step 2), switch remote access on (step
            3), and run the tunnel. Opening your hostname asks for the Cloudflare sign-in, then the
            authenticator code.
          </p>
        </div>
        <div className="dialog-footer">
          <span />
          <div className="actions">
            <button type="button" className="btn" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
