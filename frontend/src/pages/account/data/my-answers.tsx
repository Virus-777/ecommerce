// Account › Reviews › "Your answers": answers the customer wrote to other shoppers' questions.
// API: GET /api/store/reviews/me/answers (newest first, with the question, the product and canEdit),
// PATCH /api/store/reviews/me/answers/{id} (edit a published answer, or fix and resubmit one with an edit request).
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Dialog, Field, Pager, Textarea, announce, type Tone } from '@marketly/web-shared/ui';
import { useEditMyAnswer } from '../../store/data/questions';
import { date, slugify } from './when';

type MyAnswer = components['schemas']['reviews.MyAnswer'];

const LIMIT = 20;
const STATUS: Record<string, { label: string; tone: Tone }> = {
  published: { label: 'Published', tone: 'success' },
  pending_review: { label: 'Being checked', tone: 'info' },
  edit_requested: { label: 'Edit requested', tone: 'warning' },
  removed: { label: 'Removed', tone: 'danger' },
};

/** The customer's answers, paged; used for the tab count too. */
export function useMyAnswers(page: number) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['reviews', 'me', 'answers', page],
    queryFn: () => call(api.GET('/api/store/reviews/me/answers', { params: { query: { page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });
}

export function MyAnswers() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const list = useMyAnswers(page);
  const edit = useEditMyAnswer();
  const [editing, setEditing] = useState<MyAnswer | null>(null);
  const [text, setText] = useState('');
  const tooShort = text.trim().length < 2;

  const open = (a: MyAnswer) => {
    edit.reset();
    setText(a.answer.text);
    setEditing(a);
  };
  const save = () => {
    if (!editing || tooShort) return;
    edit.mutate(
      { answerId: editing.answer.id, text: text.trim() },
      {
        onSuccess: (a) => {
          setEditing(null);
          announce(a.status === 'published' ? 'Answer updated' : 'Answer sent for review');
          void qc.invalidateQueries({ queryKey: ['reviews'] });
        },
      },
    );
  };

  if (list.isError)
    return (
      <Alert tone="danger" title="We couldn't load your answers">
        {errorMessage(list.error)}{' '}
        <Button variant="ghost" size="sm" onClick={() => void list.refetch()}>
          Try again
        </Button>
      </Alert>
    );
  if (list.isPending) return <div className="card pad" aria-hidden="true"><span className="sk sk-line" /></div>;
  if (!list.data.items.length) return <p className="small muted">You haven't answered any shoppers' questions yet. You can answer from a product's Questions and answers.</p>;

  return (
    <>
      {list.data.items.map((a) => {
        const s = STATUS[a.answer.status] ?? { label: a.answer.status, tone: '' as Tone };
        const slug = a.productSlug || slugify(a.productTitle);
        return (
          <article key={a.answer.id} className="card">
            <div className="card-body stack gap-2">
              <div className="row between gap-2 top">
                <Link className="small strong link-plain" to={href('store/questions', '', { slug, id: a.productId })}>
                  {a.productTitle}
                </Link>
                <Badge tone={s.tone}>{s.label}</Badge>
              </div>
              <p className="small">
                <span className="muted">Question: </span>
                {a.questionText}
              </p>
              <p className="small sub">{a.answer.text}</p>
              <span className="xs muted">
                Answered {date(a.answer.answeredAt)}
                {a.answer.helpfulCount > 0 && ` · ${a.answer.helpfulCount} found this helpful`}
              </span>
              {a.answer.status === 'edit_requested' && <Alert tone="warning">Marketly asked for a change before this answer can be shown. Fix it and send it again.</Alert>}
              {a.canEdit && (
                <span>
                  <Button variant="secondary" size="sm" icon="pencil" onClick={() => open(a)}>
                    {a.answer.status === 'edit_requested' ? 'Fix and resubmit' : 'Edit answer'}
                  </Button>
                </span>
              )}
            </div>
          </article>
        );
      })}
      {(list.data.totalPages ?? 1) > 1 && <Pager page={page} total={list.data.totalPages!} onPage={setPage} only="website" />}
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit your answer"
        foot={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={edit.isPending || tooShort}>
              {edit.isPending ? 'Saving…' : 'Save answer'}
            </Button>
          </>
        }
      >
        {editing && <p className="small muted">{editing.questionText}</p>}
        {edit.isError && <Alert tone="danger">{errorMessage(edit.error)}</Alert>}
        <Field label="Your answer" hint="An edited answer is checked again before it shows.">
          <Textarea id="my-answer-text" rows={5} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
