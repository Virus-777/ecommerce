// "Message seller" / "Message applicant" on the admin seller screens:
// POST /api/admin/messaging/conversations { sellerId | applicationId, subject, body } (staff `messaging.conversations.participate`).
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { Alert, Button, Dialog, Field, Textarea, TextInput, announce } from '@marketly/web-shared/ui';

export function MessageDialog({ open, onClose, to, target, onSent }: { open: boolean; onClose: () => void; to: string; target: { sellerId: string } | { applicationId: string }; onSent: (text: string) => void }) {
  const { api } = useApi();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [tried, setTried] = useState(false);
  const send = useMutation({
    mutationFn: () => call(api.POST('/api/admin/messaging/conversations', { body: { ...target, subject: subject.trim(), body: body.trim() } })),
    onSuccess: () => {
      onSent(`Your message to ${to} was sent. Replies arrive in the staff inbox.`);
      announce('Message sent');
      setSubject('');
      setBody('');
      setTried(false);
      onClose();
    },
  });
  const subjectError = tried && !subject.trim() ? 'Enter a subject.' : undefined;
  const bodyError = tried && !body.trim() ? 'Write a message.' : undefined;
  const submit = () => {
    setTried(true);
    if (!subject.trim() || !body.trim()) return;
    send.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Message ${to}`}
      size="sm"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="send" onClick={submit} disabled={send.isPending}>
            Send message
          </Button>
        </>
      }
    >
      {send.isError && (
        <Alert tone="danger" title="We couldn’t send the message">
          {errorMessage(send.error)}
        </Alert>
      )}
      <Field label="Subject" error={subjectError}>
        <TextInput id="aa-msg-subject" value={subject} error={!!subjectError} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label="Message" error={bodyError}>
        <Textarea id="aa-msg-body" value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
    </Dialog>
  );
}
