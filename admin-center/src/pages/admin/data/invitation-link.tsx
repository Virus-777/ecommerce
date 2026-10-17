import type { ReactNode } from 'react';
import { Alert, Button, CopyButton, Dialog, Field, TextInput } from '@marketly/web-shared/ui';
import { date } from '@/app/parts';

// The link and pass code of a new staff invitation (invite or resend). The API returns them once and no email is
// sent from the offline server, so the inviter copies them here and hands them over; closing the dialog loses the
// pass code (Resend issues a new link and pass code).

export interface IssuedLink {
  name: string;
  email: string;
  acceptUrl: string;
  passCode: string;
  expiresAt: string;
}

export function InvitationLinkDialog({ link, title, onClose, children }: { link: IssuedLink | null; title: string; onClose: () => void; children?: ReactNode }) {
  const both = link ? `Invitation link: ${link.acceptUrl}\nPass code: ${link.passCode}` : '';
  return (
    <Dialog
      open={!!link}
      onClose={onClose}
      title={title}
      dismissable={false}
      foot={
        link && (
          <>
            <CopyButton text={both}>Copy link and pass code</CopyButton>
            <Button onClick={onClose}>Done</Button>
          </>
        )
      }
    >
      {link && (
        <>
          <span className="small">
            Give {link.name} ({link.email}) this link and pass code; they need both to set a password and sign in. No email is sent from this server. The link works until {date(link.expiresAt)}.
          </span>
          <Field label="Invitation link">
            <span className="row gap-2 nowrap">
              <TextInput id="il-url" className="mono" readOnly value={link.acceptUrl} onFocus={(e) => e.currentTarget.select()} />
              <CopyButton text={link.acceptUrl} label="Copy the invitation link" />
            </span>
          </Field>
          <Field label="Pass code">
            <span className="row gap-2 nowrap">
              <TextInput id="il-code" className="mono" readOnly value={link.passCode} onFocus={(e) => e.currentTarget.select()} />
              <CopyButton text={link.passCode} label="Copy the pass code" />
            </span>
          </Field>
          <Alert tone="warning" title="The pass code is shown only once">
            Copy it before you close this window. For safety, hand the link and the pass code over separately, for example the link in a message and the pass code in person.
          </Alert>
          {children}
        </>
      )}
    </Dialog>
  );
}
