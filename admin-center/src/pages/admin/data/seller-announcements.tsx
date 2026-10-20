// Admin › Sellers › Announcements (?filter=announcements): messages from Marketly to sellers. No design: the list
// reuses the Sellers card, table and phone-card markup; the New announcement dialog follows the Invite seller dialog.
// It lives under Sellers (not Notification templates) because the Seller Manager, who sends them, has no access to
// the templates page. Both need notifications.announcements.send (Seller Manager, Platform Administrator).
// Data: GET /api/admin/notifications/announcements (newest first; page on the website, cursor on the phone),
// GET /api/admin/sellers/sellers (the seller picker), GET …/sellers/stats (how many active sellers "all" reaches).
// Write: POST /api/admin/notifications/announcements. It is not idempotent: a second POST sends a second message to
// every seller, so Send is guarded against double clicks (a ref, not only the disabled button).
import { useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { useIsPhone } from '@marketly/web-shared/lib/hooks';
import { Alert, Badge, Button, Chip, Dialog, EmptyState, Field, Icon, LogoTile, Pager, Radio, SearchInput, Select, StatusBadge, TableWrap, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { LoadError, actorLabel, dateTime, shortDate } from '@/app/parts';
import { initialsOf, statusLabel, tintOf, useDebounced, type SellerRow } from './seller';

export type Announcement = components['schemas']['notifications.Announcement'];
type AnnouncementInput = components['schemas']['notifications.AnnouncementInput'];

export const ANNOUNCE_PERMISSION = 'notifications.announcements.send';
/** The backend's limits (notifications spec, AnnouncementInput) */
const MAX = { title: 120, body: 2000, sellers: 500, label: 40, linkId: 200 } as const;
const LIMIT = 24;
/** Sellers an announcement to "all" reaches: approved or restricted when it is sent */
const ACTIVE = ['approved', 'restricted'];

/**
 * Seller Center screens an announcement can open. A list screen needs no record, but the API asks for an id, so it
 * gets the screen's short name; the help article's id is the article slug (Seller Center opens /help/articles/<slug>).
 * No link: the notice opens the seller's Notifications page, where the whole message is shown.
 */
const LINK_SCREENS: Array<{ value: string; label: string }> = [
  { value: '', label: 'No link (the seller’s Notifications page)' },
  { value: 'seller/help-article', label: 'A help article' },
  { value: 'seller/help', label: 'Help and support' },
  { value: 'seller/store', label: 'Store profile' },
  { value: 'seller/shipping', label: 'Shipping settings' },
  { value: 'seller/performance', label: 'Account health' },
  { value: 'seller/finance', label: 'Finance' },
  { value: 'seller/products', label: 'Products and offers' },
];
const screenLabel = (screen: string) => LINK_SCREENS.find((s) => s.value === screen)?.label ?? screen;

const skeleton = (
  <div className="sk-list" aria-hidden="true">
    {Array.from({ length: 4 }, (_, i) => (
      <div key={i} className="sk-row">
        <span className="sk sk-line" />
        <span className="sk sk-line short" />
      </div>
    ))}
  </div>
);

const audienceText = (a: Announcement) => (a.audience === 'all' ? `All active sellers (${a.sellerCount})` : `${a.sellerCount} chosen seller${a.sellerCount === 1 ? '' : 's'}`);
const linkText = (a: Announcement) => (a.link ? `${a.link.label || 'Read more'} → ${screenLabel(a.link.screen)}${a.link.screen === 'seller/help-article' ? ` (${a.link.id})` : ''}` : 'Notifications page');

/* ------------------------------------------------------------------ list */

/** The announcements sent so far, newest first. `onNew` opens the New announcement dialog (from the empty state). */
export function AnnouncementsList({ onNew }: { onNew: () => void }) {
  const { api } = useApi();
  const isPhone = useIsPhone();
  const [page, setPage] = useState(1);
  const listQ = useQuery({
    queryKey: ['notifications', 'announcements', 'list', page],
    queryFn: () => call(api.GET('/api/admin/notifications/announcements', { params: { query: { page, limit: LIMIT } } })),
    enabled: !isPhone,
    placeholderData: keepPreviousData,
  });
  const phoneQ = useInfiniteQuery({
    queryKey: ['notifications', 'announcements', 'list', 'phone'],
    queryFn: ({ pageParam }) => call(api.GET('/api/admin/notifications/announcements', { params: { query: { cursor: pageParam || undefined, limit: LIMIT } } })),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isPhone,
  });
  const active = isPhone ? phoneQ : listQ;
  const loaded = isPhone ? !!phoneQ.data : !!listQ.data;
  const rows: Announcement[] = isPhone ? (phoneQ.data?.pages.flatMap((p) => p.items) ?? []) : (listQ.data?.items ?? []);
  const totalPages = listQ.data?.totalPages ?? 1;

  return (
    <>
      <div className="card-body">
        <div className="toolbar">
          <span className="small sub grow">Messages from Marketly to sellers. Each seller sees it in Seller Center › Notifications, and the store owner also gets it by email. Sent announcements can’t be changed or withdrawn.</span>
        </div>
      </div>
      {active.isError && !loaded ? (
        <div className="card-body">
          <LoadError error={active.error} onRetry={() => void active.refetch()} title="We couldn’t load the announcements" />
        </div>
      ) : !loaded ? (
        skeleton
      ) : !rows.length ? (
        <EmptyState
          icon="megaphone"
          title="No announcements yet"
          action={
            <Button size="sm" icon="megaphone" onClick={onNew}>
              New announcement
            </Button>
          }
        >
          Announcements you send to sellers appear here.
        </EmptyState>
      ) : (
        <>
          <div className="no-phone">
            <TableWrap label="Announcements table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Sent</th>
                    <th scope="col">Announcement</th>
                    <th scope="col">Audience</th>
                    <th scope="col">Opens</th>
                    <th scope="col">Sent by</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <span className="small nowrap">{dateTime(a.sentAt)}</span>
                      </td>
                      <td>
                        <span className="stack gap-0 u-maxw-28ch">
                          <span className="small strong">{a.title}</span>
                          <span className="xs sub clamp-2" title={a.body}>
                            {a.body}
                          </span>
                        </span>
                      </td>
                      <td>{a.audience === 'all' ? <Badge tone="info">{audienceText(a)}</Badge> : <span className="small">{audienceText(a)}</span>}</td>
                      <td>
                        <span className="xs sub">{linkText(a)}</span>
                      </td>
                      <td>
                        <span className="small">{actorLabel(a.sentBy)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
          <div className="only-phone card-pad-phone">
            <div className="aa-mlist">
              {rows.map((a) => (
                <div key={a.id} className="aa-mcard">
                  <span className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">{a.title}</span>
                    <span className="xs muted nowrap">{shortDate(a.sentAt)}</span>
                  </span>
                  <span className="xs sub clamp-2">{a.body}</span>
                  <span className="xs muted">
                    {audienceText(a)} · {actorLabel(a.sentBy)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      <div className="card-foot between">
        <span className="xs muted">Announcements are essential notices: sellers can’t turn them off.</span>
        {isPhone
          ? phoneQ.hasNextPage && (
              <Button variant="ghost" size="sm" onClick={() => void phoneQ.fetchNextPage()} disabled={phoneQ.isFetchingNextPage}>
                {phoneQ.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            )
          : totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} only="website" />}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ seller picker */

type Picked = Pick<SellerRow, 'id' | 'storeName' | 'ref'>;

/** Search the sellers list and pick sellers as chips (active sellers only: approved or restricted). */
function SellerPicker({ picked, onChange, error }: { picked: Picked[]; onChange: (p: Picked[]) => void; error?: string }) {
  const { api } = useApi();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const results = useQuery({
    queryKey: ['sellers', 'list', 'announcement-picker', term],
    queryFn: () => call(api.GET('/api/admin/sellers/sellers', { params: { query: { q: term, limit: 10 } } })),
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
  });
  const ids = new Set(picked.map((p) => p.id));
  const found = (results.data?.items ?? []).filter((r) => ACTIVE.includes(r.status) && !ids.has(r.id));
  const full = picked.length >= MAX.sellers;

  return (
    <div className="stack gap-2">
      <SearchInput id="aa-an-seller-q" label="Find sellers" placeholder="Search seller name, legal name or contact email" value={q} onChange={setQ} />
      {term.length >= 2 && (
        <div className="stack gap-1" aria-live="polite">
          {results.isError ? (
            <span className="xs t-danger-text">{errorMessage(results.error)}</span>
          ) : results.isFetching && !results.data ? (
            <span className="xs muted">Searching…</span>
          ) : found.length ? (
            <ul className="list">
              {found.map((r) => (
                <li key={r.id}>
                  <span className="row nowrap gap-2 grow min-w-0">
                    <LogoTile initials={initialsOf(r.storeName)} tint={tintOf(r.storeName)} size="sm" />
                    <span className="stack gap-0 min-w-0">
                      <span className="small strong">{r.storeName}</span>
                      <span className="xs muted">{r.ref}</span>
                    </span>
                  </span>
                  {r.status !== 'approved' && <StatusBadge status={statusLabel(r.status)} />}
                  <Button variant="secondary" size="sm" icon="plus" disabled={full} onClick={() => onChange([...picked, { id: r.id, storeName: r.storeName, ref: r.ref }])}>
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <span className="xs muted">No active seller matches “{term}”.</span>
          )}
        </div>
      )}
      {picked.length > 0 && (
        <div className="row gap-2" aria-label="Chosen sellers">
          {picked.map((p) => (
            <Chip key={p.id} removable onClick={() => onChange(picked.filter((x) => x.id !== p.id))}>
              <span className="sr-only">Remove </span>
              {p.storeName}
            </Chip>
          ))}
        </div>
      )}
      {error ? (
        <span className="error-text">
          <Icon name="circle-alert" className="ic-sm" />
          {error}
        </span>
      ) : (
        <span className="xs muted">{picked.length ? `${picked.length} of up to ${MAX.sellers} sellers chosen.` : 'Type at least 2 letters to search. Only approved and restricted sellers can be chosen.'}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ preview */

/** How the notice looks in Seller Center › Notifications (the same row markup as that page). */
function NoticePreview({ title, body, linkLabel }: { title: string; body: string; linkLabel: string }) {
  return (
    <div className="card" aria-label="Preview of the seller notice">
      <div className="sb-grp">Preview · Seller Center notifications</div>
      <div className="sb-note is-unread">
        <span className="ic">
          <Icon name="megaphone" />
        </span>
        <span className="stack gap-1 min-w-0">
          <span className="row gap-2 nowrap">
            <span className="dot" aria-hidden="true" />
            <span className="small bold">{title.trim() || 'Title'}</span>
          </span>
          <span className="xs sub">{body.trim() || 'Your message to sellers.'}</span>
          <span className="row gap-2">
            <Badge tone="outline">Account &amp; finance</Badge>
            <span className="xs strong">{linkLabel}</span>
          </span>
        </span>
        <span className="side">
          <span className="xs muted nowrap">Just now</span>
        </span>
      </div>
      <div className="card-foot">
        <span className="xs muted">Email subject: Marketly: {title.trim() || 'Title'}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ new announcement */

interface Draft {
  title: string;
  body: string;
  audience: 'all' | 'chosen';
  sellers: Picked[];
  screen: string;
  slug: string;
  label: string;
}
const EMPTY: Draft = { title: '', body: '', audience: 'all', sellers: [], screen: '', slug: '', label: '' };

function draftErrors(d: Draft): Partial<Record<'title' | 'body' | 'sellers' | 'slug' | 'label', string>> {
  const e: Partial<Record<'title' | 'body' | 'sellers' | 'slug' | 'label', string>> = {};
  if (!d.title.trim()) e.title = 'Add a title.';
  else if (d.title.trim().length > MAX.title) e.title = `At most ${MAX.title} characters.`;
  if (!d.body.trim()) e.body = 'Add the message.';
  else if (d.body.trim().length > MAX.body) e.body = `At most ${MAX.body} characters.`;
  if (d.audience === 'chosen' && !d.sellers.length) e.sellers = 'Choose at least one seller, or send to all active sellers.';
  if (d.screen === 'seller/help-article' && !d.slug.trim()) e.slug = 'Enter the article’s address name, like what-a-restriction-affects.';
  if (d.label.trim().length > MAX.label) e.label = `At most ${MAX.label} characters.`;
  return e;
}

function inputOf(d: Draft): AnnouncementInput {
  const linkId = d.screen === 'seller/help-article' ? d.slug.trim() : d.screen.replace(/^seller\//, '');
  return {
    title: d.title.trim(),
    body: d.body.trim(),
    ...(d.audience === 'chosen' ? { sellerIds: d.sellers.map((s) => s.id) } : {}),
    ...(d.screen ? { link: { screen: d.screen, id: linkId, ...(d.label.trim() ? { label: d.label.trim() } : {}) } } : {}),
  };
}

/** Compose → confirm (shows how many sellers it reaches) → send. `onSent` gets the announcement the API returns. */
export function NewAnnouncementDialog({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: (a: Announcement) => void }) {
  const { api } = useApi();
  const [d, setD] = useState<Draft>(EMPTY);
  const [step, setStep] = useState<'compose' | 'confirm'>('compose');
  const [tried, setTried] = useState(false);
  // True from the first Send click until the answer: stops a double click sending the message twice.
  const sending = useRef(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  // Same query and cache as the Sellers page header: how many sellers "all active sellers" reaches right now.
  const stats = useQuery({ queryKey: ['sellers', 'stats'], queryFn: () => call(api.GET('/api/admin/sellers/sellers/stats')), enabled: open });
  const activeCount = stats.data ? ACTIVE.reduce((n, s) => n + (stats.data!.byStatus[s] ?? 0), 0) : undefined;

  const send = useMutation({
    mutationFn: (input: AnnouncementInput) => call(api.POST('/api/admin/notifications/announcements', { body: input })),
    onSuccess: ({ announcement: a }) => {
      announce(`Announcement sent to ${a.sellerCount} seller${a.sellerCount === 1 ? '' : 's'}`);
      onSent(a);
      reset();
    },
    // A rejected field goes back to the form so its error shows next to it.
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') setStep('compose');
    },
    onSettled: () => {
      sending.current = false;
    },
  });

  const reset = () => {
    setD(EMPTY);
    setStep('compose');
    setTried(false);
    send.reset();
  };
  const close = () => {
    if (send.isPending) return;
    onClose();
  };

  const local = tried ? draftErrors(d) : {};
  const server = send.error instanceof ApiError ? send.error.fieldErrors : {};
  const errors = {
    title: local.title ?? server.title,
    body: local.body ?? server.body,
    sellers: local.sellers ?? server.sellerIds,
    slug: local.slug ?? server['link.id'],
    label: local.label ?? server['link.label'],
  };
  const fieldError = Object.keys(server).length > 0;

  const review = () => {
    setTried(true);
    if (Object.keys(draftErrors(d)).length) return;
    send.reset();
    setStep('confirm');
  };
  const submit = () => {
    if (sending.current) return;
    sending.current = true;
    send.mutate(inputOf(d));
  };

  const count = d.audience === 'all' ? activeCount : d.sellers.length;
  const reach = d.audience === 'all' ? (count === undefined ? 'every active seller' : `all ${count} active seller${count === 1 ? '' : 's'}`) : `${count} chosen seller${count === 1 ? '' : 's'}`;
  const linkLabel = d.screen ? `${d.label.trim() || 'Read more'} → ${screenLabel(d.screen)}` : 'Opens the Notifications page';

  return (
    <Dialog
      open={open}
      onClose={close}
      title={step === 'compose' ? 'New announcement to sellers' : 'Send this announcement?'}
      size={step === 'compose' ? 'lg' : 'sm'}
      dismissable={false}
      foot={
        step === 'compose' ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button icon="arrow-right" onClick={review}>
              Review and send
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep('compose')} disabled={send.isPending}>
              Back
            </Button>
            <Button icon="send" onClick={submit} disabled={send.isPending || count === 0}>
              {send.isPending ? 'Sending…' : `Send to ${count ?? 'all'} seller${count === 1 ? '' : 's'}`}
            </Button>
          </>
        )
      }
    >
      {step === 'compose' ? (
        <>
          {send.isError && fieldError && (
            <Alert tone="danger" title="The announcement wasn’t sent">
              {errorMessage(send.error)}
            </Alert>
          )}
          <Field label="Title" error={errors.title} hint={`${d.title.length} of ${MAX.title} characters`}>
            <TextInput id="aa-an-title" value={d.title} maxLength={MAX.title} error={!!errors.title} onChange={(e) => set('title', e.target.value)} />
          </Field>
          <Field label="Message" error={errors.body} hint={`${d.body.length} of ${MAX.body} characters. Plain text.`}>
            <Textarea id="aa-an-body" rows={6} value={d.body} maxLength={MAX.body} aria-invalid={!!errors.body || undefined} onChange={(e) => set('body', e.target.value)} />
          </Field>

          <fieldset className="stack gap-2 fieldset-reset">
            <legend className="label">Send to</legend>
            <Radio id="aa-an-all" name="aa-an-audience" label={`All active sellers${activeCount !== undefined ? ` (${activeCount})` : ''}`} checked={d.audience === 'all'} onChange={() => set('audience', 'all')} />
            <Radio id="aa-an-chosen" name="aa-an-audience" label="Chosen sellers" checked={d.audience === 'chosen'} onChange={() => set('audience', 'chosen')} />
            {d.audience === 'chosen' && <SellerPicker picked={d.sellers} onChange={(p) => set('sellers', p)} error={errors.sellers} />}
          </fieldset>

          <div className="ac-fgrid">
            <Field label="Link to" optional hint="The Seller Center screen the notice’s button opens.">
              <Select id="aa-an-screen" options={LINK_SCREENS} value={d.screen} onChange={(e) => set('screen', e.target.value)} />
            </Field>
            {d.screen && (
              <Field label="Button text" optional error={errors.label} hint={`${d.label.length} of ${MAX.label} characters. Read more if empty.`}>
                <TextInput id="aa-an-label" value={d.label} maxLength={MAX.label} placeholder="Read more" error={!!errors.label} onChange={(e) => set('label', e.target.value)} />
              </Field>
            )}
          </div>
          {d.screen === 'seller/help-article' && (
            <Field label="Help article address name" error={errors.slug} hint="The last part of the article’s address in Seller Center: /help/articles/what-a-restriction-affects → what-a-restriction-affects.">
              <TextInput id="aa-an-slug" className="mono" value={d.slug} maxLength={MAX.linkId} error={!!errors.slug} onChange={(e) => set('slug', e.target.value)} />
            </Field>
          )}

          <NoticePreview title={d.title} body={d.body} linkLabel={linkLabel} />
        </>
      ) : (
        <>
          {send.isError && !fieldError && (
            <Alert tone="danger" title="The announcement wasn’t sent">
              {errorMessage(send.error)}
            </Alert>
          )}
          <p className="small">
            “<span className="strong">{d.title.trim()}</span>” goes to <span className="strong">{reach}</span>
            {d.audience === 'chosen' && d.sellers.length <= 5 ? `: ${d.sellers.map((s) => s.storeName).join(', ')}` : ''}.
          </p>
          <p className="small sub">Each seller sees it in Seller Center › Notifications and the store owner gets it by email. It can’t be changed or withdrawn after it is sent.</p>
          {count === 0 && (
            <Alert tone="warning" title="No active sellers">
              There is no approved or restricted seller to send it to.
            </Alert>
          )}
        </>
      )}
    </Dialog>
  );
}
