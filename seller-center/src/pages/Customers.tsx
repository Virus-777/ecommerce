import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, fileSize, useApi, useUploads } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useIsPhone, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Deadline, Dialog, EmptyState, Field, Icon, IconButton, Img, Meter, PageHeader, Pager, SearchInput, Select, Stars5, StatusBadge, Tabs, Textarea, announce } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import {
  ANSWER_MAX_LENGTH,
  ANSWER_MIN_LENGTH,
  ANSWER_STATUS,
  ATTACHMENT_TYPES,
  FEEDBACK_REPORT_REASONS,
  INBOX_FILTERS,
  MAX_ATTACHMENT_MB,
  MAX_ATTACHMENTS,
  MESSAGE_MAX_LENGTH,
  MESSAGE_REPORT_REASONS,
  RESPONSE_MAX_LENGTH,
  RESPONSE_STATUS,
  TEMPLATE_NAME_MAX,
  attachmentName,
  awaiting,
  dateTime,
  dueTone,
  duration,
  ownAnswer,
  publicTextError,
  replyLabel,
  shortDate,
  subjectLine,
  subjectNoun,
  subjectRef,
  writeError,
  type FeedbackRow,
  type InboxFilter,
  type Message,
  type QuestionRow,
  type ResponseStats,
} from './data/customers';

// Design: pages/seller/seller-customers.html (order messages) · views: product-questions, feedback (tabs).
// API: messaging (seller conversations, messages, read, response-stats, templates, message reports) and
// reviews (seller questions/answers and skip, feedback, feedback-summary with its target, responses, reports).
// Messages carry viewerReported, so "Reported to Marketly" survives a reload.

type Tab = '' | 'product-questions' | 'feedback';

interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
  page?: number;
  totalPages?: number;
  total?: number;
}

/** Website: numbered pages; phone (Android app): cursor + Load more (API.md rule 9). */
function usePagedList<T>(key: readonly unknown[], fetchPage: (p: { page?: number; cursor?: string }) => Promise<PageOf<T>>, enabled = true) {
  const isPhone = useIsPhone();
  const [page, setPage] = useState(1);
  const keyStr = JSON.stringify(key);
  useEffect(() => setPage(1), [keyStr]);
  const pageQ = useQuery({ queryKey: [...key, { page }], queryFn: () => fetchPage({ page }), enabled: enabled && !isPhone, placeholderData: keepPreviousData });
  const phoneQ = useInfiniteQuery({
    queryKey: [...key, 'cursor'],
    initialPageParam: '',
    queryFn: ({ pageParam }) => fetchPage(pageParam ? { cursor: pageParam } : {}),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && isPhone,
  });
  const q = isPhone ? phoneQ : pageQ;
  const items: T[] = isPhone ? (phoneQ.data?.pages.flatMap((p) => p.items) ?? []) : (pageQ.data?.items ?? []);
  const totalPages = pageQ.data?.totalPages ?? 1;
  const footer: ReactNode = isPhone ? (
    phoneQ.hasNextPage ? (
      <Button variant="ghost" size="sm" className="only-phone" onClick={() => void phoneQ.fetchNextPage()} disabled={phoneQ.isFetchingNextPage}>
        {phoneQ.isFetchingNextPage ? 'Loading…' : 'Load more'}
      </Button>
    ) : null
  ) : totalPages > 1 ? (
    <Pager page={page} total={totalPages} onPage={setPage} only="website" />
  ) : null;
  return { items, isPending: q.isPending, isError: q.isError, error: q.error, refetch: () => void q.refetch(), isSuccess: q.isSuccess, footer };
}

function LoadError({ title, error, retry }: { title: string; error: unknown; retry: () => void }) {
  return (
    <Alert tone="danger" title={title}>
      {errorMessage(error)}{' '}
      <Button variant="ghost" size="sm" onClick={retry}>
        Try again
      </Button>
    </Alert>
  );
}

function SkeletonRows({ n = 3, className }: { n?: number; className?: string }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={cx('sk-row', className)} aria-hidden="true">
          <span className="sk sk-thumb" />
          <span className="sk-lines">
            <span className="sk sk-line" />
            <span className="sk sk-line short" />
          </span>
        </div>
      ))}
    </>
  );
}

function SkeletonCards({ n = 2 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <section key={i} className="card" aria-hidden="true">
          <div className="card-body sk-card">
            <SkeletonRows n={1} />
            <span className="sk sk-line" />
          </div>
        </section>
      ))}
    </>
  );
}

export default function Customers() {
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const tab: Tab = view === 'product-questions' || view === 'feedback' ? view : '';
  const { api } = useApi();
  const { sellerId } = useSellerSession();

  // Tab counts: awaiting reply (response stats, shared with the sidebar), open questions, negative feedback without a response.
  const stats = useQuery({ queryKey: ['messaging', 'stats', sellerId], queryFn: () => call(api.GET('/api/seller/messaging/response-stats')) });
  const openQs = useQuery({
    queryKey: ['reviews', 'questions', sellerId, 'open-count'],
    queryFn: () => call(api.GET('/api/seller/reviews/questions', { params: { query: { state: 'open', page: 1, limit: 1 } } })),
  });
  const needsResponse = useQuery({
    queryKey: ['reviews', 'feedback', sellerId, 'needs-response-count'],
    queryFn: () => call(api.GET('/api/seller/reviews/feedback', { params: { query: { needsResponse: true, sentiment: 'negative', page: 1, limit: 1 } } })),
  });

  const tabs = [
    { value: '' as Tab, label: 'Order messages', count: stats.data?.awaitingReply },
    { value: 'product-questions' as Tab, label: 'Product questions', count: openQs.data?.total },
    { value: 'feedback' as Tab, label: 'Feedback', count: needsResponse.data?.total },
  ];

  return (
    <SellerLayout active="customers">
      <PageHeader title="Store customers" sub="Order messages are private to each order. Questions and feedback responses are public." />
      <div className="u-mb-calc--1-x-sp-2">
        <Tabs items={tabs} active={tab} onChange={(v) => setView(v as Exclude<Tab, ''>)} />
      </div>
      {tab === '' && <OrderMessages stats={stats.data} statsError={stats.isError} />}
      {tab === 'product-questions' && <ProductQuestions />}
      {tab === 'feedback' && <Feedback />}
    </SellerLayout>
  );
}

/* ================================================================ Order messages */

function OrderMessages({ stats, statsError }: { stats?: ResponseStats; statsError: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const canReply = can('messaging.conversations.reply');

  const [filter, setFilter] = useState<InboxFilter>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = usePagedList(
    ['messaging', 'conversations', sellerId, { filter, q: query }],
    ({ page, cursor }) =>
      call(api.GET('/api/seller/messaging/conversations', { params: { query: { filter, ...(query ? { q: query } : {}), limit: 20, ...(cursor ? { cursor } : { page }) } } })),
    canReply,
  );
  const convs = list.items;
  const [picked, setPicked] = useState<string | null>(null);
  const activeId = picked ?? convs[0]?.id ?? null;
  const summary = convs.find((c) => c.id === activeId);

  const conversation = useQuery({
    queryKey: ['messaging', 'conversation', sellerId, activeId],
    queryFn: () => call(api.GET('/api/seller/messaging/conversations/{id}', { params: { path: { id: activeId! } } })),
    enabled: canReply && !!activeId,
  });
  const messages = useInfiniteQuery({
    queryKey: ['messaging', 'messages', sellerId, activeId],
    initialPageParam: '',
    queryFn: ({ pageParam }) => call(api.GET('/api/seller/messaging/conversations/{id}/messages', { params: { path: { id: activeId! }, query: { limit: 30, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: canReply && !!activeId,
  });
  // Newest first from the API; the thread shows oldest first.
  const log: Message[] = (messages.data?.pages.flatMap((p) => p.items) ?? []).slice().reverse();
  const newest = messages.data?.pages[0]?.items[0];

  const refreshInbox = (id?: string | null) => {
    void qc.invalidateQueries({ queryKey: ['messaging', 'conversations', sellerId] });
    void qc.invalidateQueries({ queryKey: ['messaging', 'stats', sellerId] });
    if (id) {
      void qc.invalidateQueries({ queryKey: ['messaging', 'conversation', sellerId, id] });
      void qc.invalidateQueries({ queryKey: ['messaging', 'messages', sellerId, id] });
    }
  };

  // Opening an unread conversation marks it read up to the newest message.
  const markRead = useMutation({
    mutationFn: ({ id, upTo }: { id: string; upTo: string }) => call(api.POST('/api/seller/messaging/conversations/{id}/read', { params: { path: { id } }, body: { upToMessageId: upTo } })),
    onSuccess: () => refreshInbox(),
  });
  useEffect(() => {
    if (activeId && newest && summary?.unread && !markRead.isPending) markRead.mutate({ id: activeId, upTo: newest.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, newest?.id, summary?.unread]);

  // Reply
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = activeId ? (drafts[activeId] ?? '') : '';
  const [replyErr, setReplyErr] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const clientMessageId = useRef<string | null>(null);
  const files = useUploads('message_attachment', { max: MAX_ATTACHMENTS, maxBytes: MAX_ATTACHMENT_MB * 1024 * 1024 });
  const setDraft = (text: string) => {
    if (!activeId) return;
    setDrafts((d) => ({ ...d, [activeId]: text }));
    setReplyErr('');
    clientMessageId.current = null;
  };

  const send = useMutation({
    mutationFn: ({ id, body, mediaIds }: { id: string; body: string; mediaIds: string[] }) => {
      clientMessageId.current ??= crypto.randomUUID();
      return call(api.POST('/api/seller/messaging/conversations/{id}/messages', { params: { path: { id } }, body: { body, mediaIds, clientMessageId: clientMessageId.current } }));
    },
    onSuccess: (_m, v) => {
      clientMessageId.current = null;
      setDrafts((d) => ({ ...d, [v.id]: '' }));
      files.clear();
      setReplyErr('');
      refreshInbox(v.id);
      announce(`Reply sent to ${summary?.counterparty.name ?? 'the buyer'}`);
    },
    onError: (e) => setReplyErr(writeError(e, 'body')),
  });
  const sendReply = () => {
    if (!activeId || send.isPending) return;
    const text = draft.trim();
    const err = !text && !files.assetIds.length ? 'Write a reply first.' : publicTextError(text, '', 'Order messages');
    if (err) return setReplyErr(err);
    if (files.uploading) return setReplyErr('Wait for the attachments to finish uploading.');
    send.mutate({ id: activeId, body: text, mediaIds: files.assetIds });
  };

  const pick = (id: string) => {
    setPicked(id);
    setReplyErr('');
    files.clear();
    setShowTemplates(false);
    send.reset();
    clientMessageId.current = null;
  };

  // Templates (create from the current reply, insert, delete)
  const templates = useQuery({ queryKey: ['messaging', 'templates', sellerId], queryFn: () => call(api.GET('/api/seller/messaging/templates')), enabled: canReply && showTemplates });
  const [tplName, setTplName] = useState<string | null>(null);
  const [tplErr, setTplErr] = useState('');
  const saveTemplate = useMutation({
    mutationFn: (input: { name: string; body: string }) => call(api.POST('/api/seller/messaging/templates', { body: input })),
    onSuccess: (t) => {
      setTplName(null);
      setTplErr('');
      void qc.invalidateQueries({ queryKey: ['messaging', 'templates', sellerId] });
      announce(`Template “${t.name}” saved`);
    },
    onError: (e) => setTplErr(writeError(e, 'name') || writeError(e, 'body')),
  });
  const deleteTemplate = useMutation({
    mutationFn: (id: string) => call(api.DELETE('/api/seller/messaging/templates/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['messaging', 'templates', sellerId] });
      announce('Template deleted');
    },
  });

  // Report a buyer message
  const [reporting, setReporting] = useState<Message | null>(null);
  const [reportReason, setReportReason] = useState<(typeof MESSAGE_REPORT_REASONS)[number]['value']>('abusive');
  const [reportNote, setReportNote] = useState('');
  const [reported, setReported] = useState<Record<string, boolean>>({});
  const report = useMutation({
    mutationFn: (m: Message) => call(api.POST('/api/seller/messaging/messages/{id}/report', { params: { path: { id: m.id } }, body: { reason: reportReason, note: reportNote.trim() || null } })),
    onSuccess: (_r, m) => {
      setReported((r) => ({ ...r, [m.id]: true }));
      setReporting(null);
      setReportNote('');
      announce('Message reported to Marketly');
    },
  });

  const c = conversation.data;
  const subject = c?.subject ?? summary?.subject;
  const buyer = c?.counterparty.name ?? summary?.counterparty.name ?? '';
  const state = c ?? summary;
  const tone = state ? dueTone(state) : undefined;
  const dueText = summary?.replyLabel ?? (c ? replyLabel(c) : '');
  const canSend = !!c && c.canSend && c.status === 'open';
  const overdue = state?.replyState === 'overdue';
  const empty = list.isSuccess && !convs.length && filter === 'all' && !query;

  return (
    <>
      <div className="row gap-3">
        {stats ? (
          <>
            <Badge tone="brand" icon="clock">
              Reply within {stats.targetHours} hours
            </Badge>
            <span className="xs sub">
              {stats.averageReplyMinutes != null ? `Your average this month: ${duration(stats.averageReplyMinutes)}` : 'No reply time measured this month yet'} ·{' '}
              {stats.overdue ? `${stats.overdue} conversation${stats.overdue === 1 ? '' : 's'} overdue` : 'nothing overdue'}
            </span>
          </>
        ) : statsError ? (
          <span className="xs sub">Reply statistics are unavailable right now.</span>
        ) : (
          <span className="sk sk-line short" style={{ width: '240px' }} aria-hidden="true" />
        )}
      </div>

      {!canReply ? (
        <Alert tone="info" title="Order messages are not part of your role">
          Ask the store owner for the customer service permission to read and answer buyers’ messages.
        </Alert>
      ) : list.isError ? (
        <LoadError title="We couldn’t load your order messages" error={list.error} retry={list.refetch} />
      ) : empty ? (
        <section className="card">
          <EmptyState icon="message-square" as="h2" title="No order messages yet">
            When a buyer messages you about an order, the conversation appears here with its reply deadline.
          </EmptyState>
        </section>
      ) : (
        <section className="card">
          <div className="sb-inbox">
            <div className="sb-inbox-list">
              <div className="u-p-sp-3-sp-4 u-bb-1px-solid-border stack gap-2">
                <SearchInput id="cu-q" placeholder="Search buyer or order" value={q} onChange={setQ} label="Search buyer or order" />
                <div className="row gap-2" role="group" aria-label="Show conversations">
                  {INBOX_FILTERS.map((f) => (
                    <button key={f.value} type="button" className={cx('chip', filter === f.value && 'is-active')} aria-pressed={filter === f.value} onClick={() => (setFilter(f.value), setPicked(null))}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              {list.isPending && <SkeletonRows n={4} className="u-p-sp-4" />}
              {convs.map((cv) => {
                const t = dueTone(cv);
                const late = t === 'danger';
                const waiting = awaiting(cv);
                return (
                  <a
                    key={cv.id}
                    className={cx('sb-conv', cv.id === activeId && 'is-active', late && 'is-overdue')}
                    href="#"
                    aria-current={cv.id === activeId ? 'true' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      pick(cv.id);
                    }}
                  >
                    {late && <span className="sr-only">Overdue: </span>}
                    {cv.unread && <span className="sr-only">Unread: </span>}
                    <span className="row between nowrap">
                      <span className="row gap-2 nowrap">
                        <Avatar name={cv.counterparty.name} />
                        <span className="stack gap-0">
                          <span className={cx('small', waiting || cv.unread ? 'bold' : 'strong')}>{cv.counterparty.name}</span>
                          <span className="xs muted mono">{subjectRef(cv.subject)}</span>
                        </span>
                      </span>
                      <span className="xs muted nowrap">{dateTime(cv.lastMessageAt)}</span>
                    </span>
                    <span className="xs sub truncate">
                      {cv.lastFromMe ? 'You: ' : ''}
                      {cv.lastMessagePreview}
                    </span>
                    {cv.replyLabel && <span>{waiting && t ? <Deadline tone={t}>{cv.replyLabel}</Deadline> : <span className="xs muted">{cv.replyLabel}</span>}</span>}
                  </a>
                );
              })}
              {list.isSuccess && !convs.length && <p className="small sub u-p-sp-4">{query ? `No conversations match “${query}”.` : 'No conversations in this view.'}</p>}
              {list.footer && <div className="u-p-sp-3-sp-4">{list.footer}</div>}
            </div>
            <div className="sb-conv-pane no-phone">
              {!activeId ? (
                list.isPending ? (
                  <div className="bd stack gap-2" aria-hidden="true">
                    <span className="sk sk-line" />
                    <span className="sk sk-line short" />
                  </div>
                ) : (
                  <EmptyState icon="inbox" title="No conversation selected">
                    Pick a conversation from the list.
                  </EmptyState>
                )
              ) : (
                <>
                  <div className="hd">
                    <Avatar name={buyer || ' '} />
                    <div className="stack gap-0 grow">
                      <span className="strong">{buyer}</span>
                      {subject && (
                        <span className="xs sub">
                          {subject.orderRef ? (
                            <>
                              Order{' '}
                              <Link className="mono" to={href('seller/order', '', { ref: subject.orderRef })}>
                                {subject.orderRef}
                              </Link>
                            </>
                          ) : (
                            <span className="mono">{subjectRef(subject)}</span>
                          )}
                          {subjectLine(subject) && ` · ${subjectLine(subject)}`}
                          {subject.statusLabel && (
                            <>
                              {' · '}
                              <StatusBadge status={subject.statusLabel} />
                            </>
                          )}
                        </span>
                      )}
                    </div>
                    {state && awaiting(state) && tone && dueText && <Deadline tone={tone}>{dueText}</Deadline>}
                  </div>
                  <div className="bd sb-thread" aria-live="polite">
                    {messages.hasNextPage && (
                      <Button variant="ghost" size="sm" onClick={() => void messages.fetchNextPage()} disabled={messages.isFetchingNextPage}>
                        {messages.isFetchingNextPage ? 'Loading…' : 'Show earlier messages'}
                      </Button>
                    )}
                    {(conversation.isPending || messages.isPending) && (
                      <span className="stack gap-2" aria-hidden="true">
                        <span className="sk sk-line" />
                        <span className="sk sk-line short" />
                      </span>
                    )}
                    {(conversation.isError || messages.isError) && (
                      <LoadError title="We couldn’t load this conversation" error={conversation.error ?? messages.error} retry={() => void (conversation.isError ? conversation.refetch() : messages.refetch())} />
                    )}
                    {c && subject && (
                      <span className="sb-sysnote">
                        <Icon name="lock" className="ic-sm" />
                        Private conversation linked to this {subjectNoun(subject)}. {c.privacyNote.replace(/\.?$/, '.')}
                      </span>
                    )}
                    {log.map((m) =>
                      m.kind === 'system' ? (
                        <span key={m.id} className="sb-sysnote">
                          <Icon name="info" className="ic-sm" />
                          {m.body}
                        </span>
                      ) : (
                        <div key={m.id} className={cx('sb-msg', m.fromMe && 'me')}>
                          <span className="who">
                            {m.fromMe ? (m.author?.name ? `You · ${m.author.name}` : 'You') : m.authorLabel}
                            <span className="when">{dateTime(m.at)}</span>
                          </span>
                          {m.hidden ? <span className="muted">{m.hiddenReason ?? 'Marketly hid this message.'}</span> : m.body && <span>{m.body}</span>}
                          {!m.hidden &&
                            m.attachments.map((a, i) => (
                              <span key={a.id} className="row gap-1 xs">
                                <Icon name="paperclip" className="ic-sm" />
                                <a href={a.url} target="_blank" rel="noreferrer">
                                  {attachmentName(a, i)}
                                </a>
                                {a.bytes ? <span className="muted">{fileSize(a.bytes)}</span> : null}
                              </span>
                            ))}
                          {m.redactions.length > 0 && <span className="xs muted">Contact details or links in this message were masked.</span>}
                          {!m.fromMe && !m.hidden && (
                            <span>
                              {reported[m.id] || m.viewerReported ? (
                                <span className="xs muted">Reported to Marketly</span>
                              ) : (
                                <button type="button" className="btn-bare tight xs muted" onClick={() => (setReporting(m), report.reset())}>
                                  <Icon name="flag" className="ic-sm" /> Report
                                </button>
                              )}
                            </span>
                          )}
                        </div>
                      ),
                    )}
                    {c?.dispatchWarning && (
                      <span className="sb-sysnote">
                        <Icon name="triangle-alert" className="ic-sm" />
                        {c.dispatchWarning}
                      </span>
                    )}
                  </div>
                  <div className="ft">
                    {overdue && (
                      <Alert tone="danger" title="Reply target missed">
                        You aim to reply within {stats?.targetHours ?? 24} hours
                        {c?.dispatchWarning ? ', and this buyer also has an overdue dispatch. Reply with a real ship date.' : '. Reply as soon as you can.'}
                      </Alert>
                    )}
                    {c && !canSend ? (
                      <p className="row gap-1 xs muted">
                        <Icon name="lock" className="ic-sm" />
                        <span>{c.lockedReason ?? (c.status === 'archived' ? 'This conversation is archived and takes no new messages.' : 'This conversation takes no new messages.')}</span>
                      </p>
                    ) : (
                      <>
                        <Field label={`Reply to ${buyer || 'the buyer'}`} error={replyErr || files.error}>
                          <Textarea id="cu-reply" placeholder="" maxLength={MESSAGE_MAX_LENGTH} value={draft} disabled={!c} onChange={(e) => setDraft(e.target.value)} />
                        </Field>
                        {files.items.length > 0 && (
                          <div className="row gap-2">
                            {files.items.map((f) => (
                              <button key={f.key} type="button" className="chip" onClick={() => files.remove(f.key)} aria-label={`Remove ${f.name}`} title={f.error}>
                                <Icon name={f.status === 'failed' ? 'circle-alert' : 'paperclip'} />
                                {f.name}
                                {f.status === 'uploading' ? ' (uploading…)' : f.status === 'failed' ? ' (failed)' : ''}
                                <Icon name="x" className="ic-sm" />
                              </button>
                            ))}
                          </div>
                        )}
                        {showTemplates && (
                          <div className="stack gap-2">
                            <div className="row gap-2" role="group" aria-label="Reply templates">
                              {templates.isPending && <span className="sk sk-line short" style={{ width: '160px' }} aria-hidden="true" />}
                              {templates.data?.map((t) => (
                                <span key={t.id} className="row gap-1 nowrap">
                                  <button type="button" className="chip" title={t.body} onClick={() => (setDraft(t.body), setShowTemplates(false))}>
                                    {t.name}
                                  </button>
                                  <IconButton icon="x" size="sm" label={`Delete template ${t.name}`} onClick={() => deleteTemplate.mutate(t.id)} disabled={deleteTemplate.isPending} />
                                </span>
                              ))}
                              {templates.data?.length === 0 && <span className="xs muted">No saved replies yet. Write a reply and save it as a template.</span>}
                              {draft.trim() && tplName === null && (
                                <button type="button" className="chip is-soft" onClick={() => (setTplName(''), setTplErr(''))}>
                                  <Icon name="plus" />
                                  Save reply as template
                                </button>
                              )}
                            </div>
                            {templates.isError && <span className="xs t-danger-text">{errorMessage(templates.error)}</span>}
                            {deleteTemplate.isError && <span className="xs t-danger-text">{writeError(deleteTemplate.error)}</span>}
                            {tplName !== null && (
                              <div className="row gap-2" style={{ alignItems: 'flex-end' }}>
                                <Field label="Template name" error={tplErr} className="grow">
                                  <input className="input" id="cu-tpl-name" maxLength={TEMPLATE_NAME_MAX} value={tplName} onChange={(e) => (setTplName(e.target.value), setTplErr(''))} />
                                </Field>
                                <Button variant="ghost" size="sm" onClick={() => setTplName(null)}>
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={saveTemplate.isPending}
                                  onClick={() => (tplName.trim() ? saveTemplate.mutate({ name: tplName.trim(), body: draft.trim() }) : setTplErr('Give the template a name.'))}
                                >
                                  Save template
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                        <div className="row between">
                          <div className="row gap-2">
                            <input
                              ref={fileRef}
                              type="file"
                              hidden
                              multiple
                              accept={ATTACHMENT_TYPES}
                              onChange={(e) => {
                                files.add(Array.from(e.target.files ?? []));
                                e.target.value = '';
                              }}
                            />
                            <Button variant="ghost" size="sm" icon="paperclip" onClick={() => fileRef.current?.click()} disabled={!c || files.items.length >= MAX_ATTACHMENTS}>
                              Attach
                            </Button>
                            <Button variant="ghost" size="sm" icon="file-text" aria-expanded={showTemplates} onClick={() => setShowTemplates((v) => !v)}>
                              Templates
                            </Button>
                          </div>
                          <Button icon="send" onClick={sendReply} disabled={!c || send.isPending || files.uploading}>
                            {send.isPending ? 'Sending…' : 'Send reply'}
                          </Button>
                        </div>
                      </>
                    )}
                    <span className="xs muted">Keep service messages about the order. Promotional messages are not allowed here.</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      <Dialog
        open={!!reporting}
        onClose={() => setReporting(null)}
        title="Report this message"
        foot={
          <>
            <Button variant="ghost" onClick={() => setReporting(null)}>
              Cancel
            </Button>
            <Button icon="flag" disabled={report.isPending} onClick={() => reporting && report.mutate(reporting)}>
              {report.isPending ? 'Reporting…' : 'Report to Marketly'}
            </Button>
          </>
        }
      >
        <p className="small sub">Marketly reviews reported messages. The buyer isn’t told who reported it.</p>
        <Field label="Reason">
          <Select id="cu-rep-reason" value={reportReason} onChange={(e) => setReportReason(e.target.value as typeof reportReason)} options={MESSAGE_REPORT_REASONS} />
        </Field>
        <Field label="Note" optional>
          <Textarea id="cu-rep-note" value={reportNote} onChange={(e) => setReportNote(e.target.value)} />
        </Field>
        {report.isError && <Alert tone="danger">{writeError(report.error)}</Alert>}
      </Dialog>
    </>
  );
}

/* ================================================================ Product questions */

function ProductQuestions() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, storeName, can } = useSellerSession();
  const canAnswer = can('reviews.responses.post');
  const list = usePagedList(['reviews', 'questions', sellerId, 'all'], ({ page, cursor }) =>
    call(api.GET('/api/seller/reviews/questions', { params: { query: { state: 'all', limit: 10, ...(cursor ? { cursor } : { page }) } } })),
  );

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const answer = useMutation({
    mutationFn: ({ row, text }: { row: QuestionRow; text: string }) => {
      const own = ownAnswer(row, sellerId);
      return own && own.status !== 'removed'
        ? call(api.PATCH('/api/seller/reviews/answers/{id}', { params: { path: { id: own.id } }, body: { text } }))
        : call(api.POST('/api/seller/reviews/questions/{id}/answers', { params: { path: { id: row.question.id } }, body: { text } }));
    },
    onSuccess: (a, { row }) => {
      const id = row.question.id;
      setEditing((e) => ({ ...e, [id]: false }));
      setDrafts((d) => {
        const n = { ...d };
        delete n[id];
        return n;
      });
      void qc.invalidateQueries({ queryKey: ['reviews', 'questions', sellerId] });
      announce(a.status === 'published' ? 'Answer published' : 'Answer sent to Marketly for review');
    },
    onError: (e, { row }) => setErrs((x) => ({ ...x, [row.question.id]: writeError(e, 'text') })),
  });
  // Skip (POST …/questions/{id}/skip) hides a question from the open ones; DELETE brings it back.
  const skip = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? call(api.POST('/api/seller/reviews/questions/{id}/skip', { params: { path: { id } } })) : call(api.DELETE('/api/seller/reviews/questions/{id}/skip', { params: { path: { id } } })),
    onSuccess: (_r, { on }) => {
      void qc.invalidateQueries({ queryKey: ['reviews', 'questions', sellerId] });
      announce(on ? 'Question skipped' : 'Question back in your open questions');
    },
    onError: (e, { id }) => setErrs((x) => ({ ...x, [id]: errorMessage(e) })),
  });
  const publish = (row: QuestionRow, current: string) => {
    const id = row.question.id;
    const text = current.trim();
    let err = publicTextError(text, 'Write an answer before publishing.');
    if (!err && text.length < ANSWER_MIN_LENGTH) err = `Write at least ${ANSWER_MIN_LENGTH} characters.`;
    if (!err && text.length > ANSWER_MAX_LENGTH) err = `Keep it under ${ANSWER_MAX_LENGTH.toLocaleString('en-US')} characters.`;
    setErrs((e) => ({ ...e, [id]: err }));
    if (!err) answer.mutate({ row, text });
  };

  return (
    <div className="sb-main">
      <div className="stack gap-4">
        {list.isError && <LoadError title="We couldn’t load product questions" error={list.error} retry={list.refetch} />}
        {list.isPending && <SkeletonCards />}
        {list.isSuccess && !list.items.length && (
          <section className="card">
            <EmptyState icon="message-circle-question" as="h2" title="No product questions yet">
              Questions shoppers ask on products you offer appear here for you to answer publicly.
            </EmptyState>
          </section>
        )}
        {list.items.map((row) => {
          const x = row.question;
          const own = ownAnswer(row, sellerId);
          const others = x.answers.filter((a) => a !== own).length;
          const skipped = !own && row.skipped;
          const st = own ? ANSWER_STATUS[own.status] : skipped ? { label: 'Skipped', tone: '' as const } : { label: 'Open', tone: 'info' as const };
          const formOpen = canAnswer && (!!editing[x.id] || (!own && !skipped) || own?.status === 'edit_requested' || own?.status === 'removed');
          const value = drafts[x.id] ?? (own?.status === 'edit_requested' ? own.text : '');
          const err = errs[x.id];
          return (
            <section key={x.id} className="card">
              <div className="card-body">
                <div className="row top gap-3">
                  <Img icon="package" tint="2" className="tiny" src={row.productImage?.url} alt="" />
                  <div className="stack gap-1 grow">
                    <span className="xs muted">{x.productTitle}</span>
                    <span className="strong">{x.text}</span>
                    <span className="xs muted">
                      Asked by {x.askedBy} · {shortDate(x.askedAt)}
                      {others > 0 && ` · ${others} other answer${others === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  <StatusBadge status={st.label} tone={st.tone} />
                </div>
                {own && !formOpen && own.status !== 'removed' && (
                  <div className="panel stack gap-1">
                    <span className="row gap-2">
                      <Badge tone="info" icon="store">
                        Answer from the seller
                      </Badge>
                      <span className="xs muted">
                        {own.by.displayName} · {shortDate(own.answeredAt)}
                        {own.status === 'published' ? (own.helpfulCount ? ` · ${own.helpfulCount} found this helpful` : '') : ' · waiting for Marketly review'}
                      </span>
                    </span>
                    <span className="small">{own.text}</span>
                  </div>
                )}
                {own && !formOpen && canAnswer && own.status === 'published' && (
                  <div className="row end">
                    <Button variant="ghost" size="sm" icon="pencil" onClick={() => (setDrafts((d) => ({ ...d, [x.id]: own.text })), setEditing((e) => ({ ...e, [x.id]: true })))}>
                      Edit answer
                    </Button>
                  </div>
                )}
                {own?.status === 'edit_requested' && <Alert tone="warning">Marketly asked you to edit this answer. It is off the product page until you resubmit it.</Alert>}
                {own?.status === 'removed' && <span className="xs muted">Marketly removed your earlier answer. You can write a new one.</span>}
                {skipped && canAnswer && (
                  <div className="row between gap-2">
                    <span className="xs muted">You skipped this question. Customers and Marketly staff can still answer it.</span>
                    <Button variant="ghost" size="sm" disabled={skip.isPending} onClick={() => skip.mutate({ id: x.id, on: false })}>
                      Answer instead
                    </Button>
                  </div>
                )}
                {formOpen && (
                  <>
                    <Field label="Your public answer" hint={err ? undefined : `Shown on the product page as “Answer from the seller · ${storeName}”.`} error={err}>
                      <Textarea
                        id={`cu-ans-${x.id}`}
                        placeholder="Answer the question for every shopper"
                        maxLength={ANSWER_MAX_LENGTH}
                        value={value}
                        onChange={(e) => (setDrafts((d) => ({ ...d, [x.id]: e.target.value })), setErrs((er) => ({ ...er, [x.id]: '' })))}
                      />
                    </Field>
                    <div className="row end gap-2">
                      {editing[x.id] && (
                        <Button variant="ghost" size="sm" onClick={() => setEditing((e) => ({ ...e, [x.id]: false }))}>
                          Cancel
                        </Button>
                      )}
                      {!own && !editing[x.id] && (
                        <Button variant="ghost" size="sm" disabled={skip.isPending && skip.variables?.id === x.id} onClick={() => skip.mutate({ id: x.id, on: true })}>
                          Skip
                        </Button>
                      )}
                      <Button size="sm" disabled={answer.isPending && answer.variables?.row.question.id === x.id} onClick={() => publish(row, value)}>
                        {own?.status === 'edit_requested' ? 'Resubmit answer' : editing[x.id] ? 'Save answer' : 'Publish answer'}
                      </Button>
                    </div>
                  </>
                )}
                {!canAnswer && !own && <span className="xs muted">Your role can’t answer questions. Ask the store owner for the reviews permission.</span>}
              </div>
            </section>
          );
        })}
        {list.footer}
      </div>
      <Card title="Answering questions">
        <ul className="ul small sub stack gap-1">
          <li>Answers are public and labeled as from {storeName || 'your store'}.</li>
          <li>Stick to facts in the product listing. Marketly staff and customers can answer too, each with their own label.</li>
          <li>No personal contact details, outside links or discount codes.</li>
          <li>Order-specific questions belong in order messages.</li>
        </ul>
      </Card>
    </div>
  );
}

/* ================================================================ Feedback */

function Feedback() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const canPost = can('reviews.responses.post');
  const summary = useQuery({ queryKey: ['reviews', 'feedback-summary', sellerId], queryFn: () => call(api.GET('/api/seller/reviews/feedback-summary')) });
  const list = usePagedList(['reviews', 'feedback', sellerId, 'list'], ({ page, cursor }) =>
    call(api.GET('/api/seller/reviews/feedback', { params: { query: { limit: 10, ...(cursor ? { cursor } : { page }) } } })),
  );

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [reportOpen, setReportOpen] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState<(typeof FEEDBACK_REPORT_REASONS)[number]['value']>('off_topic');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['reviews', 'feedback', sellerId] });
    void qc.invalidateQueries({ queryKey: ['reviews', 'feedback-summary', sellerId] });
  };

  const respond = useMutation({
    mutationFn: ({ row, text }: { row: FeedbackRow; text: string }) => {
      const r = row.feedback.response;
      return r
        ? call(api.PATCH('/api/seller/reviews/responses/{id}', { params: { path: { id: r.id } }, body: { text } }))
        : call(api.POST('/api/seller/reviews/responses', { body: { targetType: 'seller_feedback', targetId: row.feedback.id, text } }));
    },
    onSuccess: (r, { row }) => {
      setEditing((e) => ({ ...e, [row.feedback.id]: false }));
      refresh();
      announce(r.status === 'published' ? 'Response posted' : 'Response held for Marketly review');
    },
    onError: (e, { row }) => setErrs((x) => ({ ...x, [row.feedback.id]: writeError(e, 'text') })),
  });
  const post = (row: FeedbackRow) => {
    const id = row.feedback.id;
    const text = (drafts[id] ?? '').trim();
    let err = publicTextError(text, 'Write a response before posting.', 'Public responses');
    if (!err && text.length > RESPONSE_MAX_LENGTH) err = `Keep it under ${RESPONSE_MAX_LENGTH.toLocaleString('en-US')} characters.`;
    setErrs((e) => ({ ...e, [id]: err }));
    if (!err) respond.mutate({ row, text });
  };

  const report = useMutation({
    mutationFn: (row: FeedbackRow) => call(api.POST('/api/seller/reviews/reports', { body: { targetType: 'seller_feedback', targetId: row.feedback.id, reason: reportReason } })),
    onSuccess: () => {
      setReportOpen(null);
      refresh();
      announce('Feedback reported to Marketly for review');
    },
  });

  const s = summary.data;
  const shares = s
    ? [
        { label: 'Positive (4–5)', pct: s.positivePct ?? 0, tone: 'success' as const },
        { label: 'Neutral (3)', pct: s.neutralPct ?? 0, tone: undefined },
        { label: 'Negative (1–2)', pct: s.negativePct ?? 0, tone: 'danger' as const },
      ]
    : [];
  const now = Date.now();

  return (
    <div className="sb-main">
      <div className="stack gap-4">
        <section className="card">
          <div className="card-body">
            {summary.isError ? (
              <LoadError title="We couldn’t load your feedback summary" error={summary.error} retry={() => void summary.refetch()} />
            ) : !s ? (
              <div className="sk-card" aria-hidden="true">
                <span className="sk sk-line short" />
                <span className="sk sk-line" />
                <span className="sk sk-line" />
              </div>
            ) : (
              <div className="row gap-6">
                <div className="stack gap-0">
                  <span className="h1 num">{s.count && s.positivePct != null ? `${Math.round(s.positivePct)}%` : '–'}</span>
                  <span className="xs muted">{s.count ? `positive · ${s.count.toLocaleString('en-US')} rating${s.count === 1 ? '' : 's'} · last ${s.periodMonths} months` : s.label}</span>
                </div>
                <div className="stack gap-1 grow minw-200">
                  {shares.map((x) => (
                    <div key={x.label} className="row gap-3 nowrap">
                      <span className="xs u-w-110px">{x.label}</span>
                      <div className="grow">
                        <Meter pct={x.pct} tone={x.tone} label={x.label} />
                        {x.tone === 'danger' && s.target && !s.target.meets && (
                          <span className="xs strong meter-note t-danger-text" title={s.target.label}>
                            Below target
                          </span>
                        )}
                      </div>
                      <span className="xs num">{Math.round(x.pct)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <span className="xs muted">Seller feedback rates buying from you: dispatch, packing and communication. Product reviews describe the item and are shown separately on product pages.</span>
          </div>
        </section>
        {list.isError && <LoadError title="We couldn’t load your feedback" error={list.error} retry={list.refetch} />}
        {list.isPending && <SkeletonCards />}
        {list.isSuccess && !list.items.length && (
          <section className="card">
            <EmptyState icon="star" as="h2" title="No feedback yet">
              Buyers can rate dispatch, packing and communication after their package is delivered.
            </EmptyState>
          </section>
        )}
        {list.items.map((row) => {
          const f = row.feedback;
          const r = f.response;
          const reported = !row.canReport;
          const editable = !!r && !!r.editableUntil && Date.parse(r.editableUntil) > now;
          const formOpen = canPost && (r ? !!editing[f.id] && editable : row.canRespond);
          const err = errs[f.id];
          const st = r ? RESPONSE_STATUS[r.status] : null;
          return (
            <section key={f.id} className="card">
              <div className="card-body">
                <div className="row top gap-3">
                  <Avatar name={f.author.displayName} />
                  <div className="stack gap-1 grow">
                    <span className="row gap-2">
                      <Stars5 rating={f.overall} size="md" />
                      <span className="small strong">{f.author.displayName}</span>
                      <span className="xs muted">
                        {shortDate(f.postedAt)}
                        {f.orderRef && (
                          <>
                            {' · '}
                            <span className="mono">{f.orderRef}</span>
                          </>
                        )}
                      </span>
                      {reported && (
                        <Badge tone="warning" icon="flag">
                          Reported to Marketly
                        </Badge>
                      )}
                    </span>
                    {f.comment && <span className="small">{f.comment}</span>}
                  </div>
                </div>
                {r && !formOpen && (
                  <div className="panel stack gap-1">
                    <span className="row gap-2">
                      <Badge tone="info" icon="store">
                        Response from the seller
                      </Badge>
                      {st && r.status !== 'published' && <StatusBadge status={st.label} tone={st.tone} />}
                    </span>
                    <span className="small">{r.text}</span>
                    {r.ruleCheck && !r.ruleCheck.passed && r.ruleCheck.failures.length > 0 && <span className="xs muted">Marketly is checking: {r.ruleCheck.failures.join(', ')}.</span>}
                  </div>
                )}
                {r && !formOpen && canPost && editable && (
                  <div className="row between">
                    <span className="xs muted">You can edit it until {shortDate(r.editableUntil!)}.</span>
                    <Button variant="ghost" size="sm" icon="pencil" onClick={() => (setDrafts((d) => ({ ...d, [f.id]: r.text })), setEditing((e) => ({ ...e, [f.id]: true })))}>
                      Edit response
                    </Button>
                  </div>
                )}
                {formOpen && (
                  <>
                    <Field label="Public response" optional={!r} hint={err ? undefined : 'Shown under the feedback as “Response from the seller”. You can edit it for 7 days.'} error={err}>
                      <Textarea
                        id={`cu-fb-${f.id}`}
                        placeholder="Write a public response"
                        maxLength={RESPONSE_MAX_LENGTH}
                        value={drafts[f.id] ?? ''}
                        onChange={(e) => (setDrafts((d) => ({ ...d, [f.id]: e.target.value })), setErrs((er) => ({ ...er, [f.id]: '' })))}
                      />
                    </Field>
                    {reportOpen === f.id && (
                      <div className="row gap-2" style={{ alignItems: 'flex-end' }}>
                        <Field label="Why does it break the feedback rules?" className="grow">
                          <Select id={`cu-fb-rep-${f.id}`} value={reportReason} onChange={(e) => setReportReason(e.target.value as typeof reportReason)} options={FEEDBACK_REPORT_REASONS} />
                        </Field>
                        <Button variant="ghost" size="sm" onClick={() => setReportOpen(null)}>
                          Cancel
                        </Button>
                        <Button size="sm" variant="secondary" icon="flag" disabled={report.isPending} onClick={() => report.mutate(row)}>
                          Send report
                        </Button>
                      </div>
                    )}
                    {report.isError && report.variables?.feedback.id === f.id && <span className="xs t-danger-text">{writeError(report.error)}</span>}
                    <div className="row end gap-2">
                      {r ? (
                        <Button variant="ghost" size="sm" onClick={() => setEditing((e) => ({ ...e, [f.id]: false }))}>
                          Cancel
                        </Button>
                      ) : (
                        reportOpen !== f.id && (
                          <Button variant="ghost" size="sm" icon="flag" disabled={reported} onClick={() => (setReportOpen(f.id), report.reset())}>
                            {reported ? 'Reported' : 'Report feedback'}
                          </Button>
                        )
                      )}
                      <Button size="sm" disabled={respond.isPending && respond.variables?.row.feedback.id === f.id} onClick={() => post(row)}>
                        {r ? 'Save response' : 'Post response'}
                      </Button>
                    </div>
                  </>
                )}
                {!r && !formOpen && <span className="xs muted">{canPost ? 'The response window for this feedback has closed.' : 'Your role can’t respond to feedback. Ask the store owner for the reviews permission.'}</span>}
              </div>
            </section>
          );
        })}
        {list.footer}
      </div>
      <Card title="Rules for public responses">
        <span className="small strong">Responses may</span>
        <ul className="sb-ticks ok">
          {['Thank the customer or apologize', 'Explain what happened and what you changed', 'Invite the customer to continue in order messages'].map((t) => (
            <li key={t}>
              <Icon name="circle-check" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
        <span className="small strong">Responses may not</span>
        <ul className="sb-ticks no">
          {['Include the customer’s name beyond what they show, address or order details', 'Offer refunds or gifts in exchange for changing feedback', 'Contain outside links, contact details or insults'].map((t) => (
            <li key={t}>
              <Icon name="circle-x" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
        <p className="xs muted">Marketly does not remove legitimate negative feedback because it is unfavorable. Report feedback only if it breaks the feedback rules, for example if it is about the product instead of your service.</p>
      </Card>
    </div>
  );
}
