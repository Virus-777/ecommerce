import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AccountLayout } from '@/layouts';
import { ApiError, call, errorMessage, useApi, uploadMedia } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, EmptyState, Icon, IconButton, Img, LogoTile, SearchInput, Select, SellerBadge, type Tone } from '@marketly/web-shared/ui';
import {
  aboutLink,
  aboutOf,
  ATTACHMENT_TYPES,
  attachmentName,
  counterpartyMeta,
  isMarketly,
  MAX_ATTACHMENT_MB,
  MAX_ATTACHMENTS,
  MESSAGE_MAX_LENGTH,
  sellerTile,
  subjectLine,
  type ConversationSummary,
  type Message,
} from './data/messages';
import { daySeparator, listTime, time } from './data/when';

// Design: pages/store/account-messages.html (one view): inbox + the open conversation.
// On the phone (Android app) the conversation fills the screen; "All messages" shows the inbox.
// API: messaging (GET /api/store/messaging/conversations, …/{id}, …/{id}/messages; POST …/{id}/messages,
// …/{id}/read); attachments through media uploads (purpose message_attachment). ?conversation=<id> opens one.

type Counterparty = ConversationSummary['counterparty'];
/** The Official Store's seller id (docs/api/README.md "Constants"). */
import { OFFICIAL_STORE_ID } from '@marketly/web-shared/config';

function ThreadLogo({ c, md }: { c: Counterparty; md?: boolean }) {
  if (c.kind === 'marketplace_support') {
    return (
      <span className="logo-tile tint-brand" style={{ width: '36px', height: '36px', fontSize: '13px' } as CSSProperties} aria-hidden="true">
        <Icon name="life-buoy" className="ic-sm" />
      </span>
    );
  }
  const t = sellerTile(c.name, isMarketly(c));
  return <LogoTile initials={t.initials} tint={t.tint} size={md ? 'md' : undefined} />;
}

/** Badge tone for the subject's status label (labels come from the order/return/case modules). */
function statusTone(label: string): Tone {
  const l = label.toLowerCase();
  if (/delay|late|waiting|action|overdue|failed|problem/.test(l)) return 'warning';
  if (/cancel|declin|reject|closed/.test(l)) return 'danger';
  if (/deliver|approv|refunded|resolved|complete/.test(l)) return 'success';
  return 'info';
}

interface Pick {
  key: string;
  file: File;
}

export default function Messages() {
  const { api, session } = useApi();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [phoneList, setPhoneList] = useState(false);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<Pick[]>([]);
  const [fileMsg, setFileMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const clientMessageId = useRef<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const inbox = useInfiniteQuery({
    queryKey: ['messaging', 'conversations', query],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => call(api.GET('/api/store/messaging/conversations', { params: { query: { ...(query ? { q: query } : {}), limit: 30, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    getNextPageParam: (last) => last.nextCursor,
  });
  const threads = inbox.data?.pages.flatMap((p) => p.items) ?? [];

  // ?order=<ref>[&seller=<sellerId>]: open the conversation about that order, or start one.
  const convParam = params.get('conversation');
  const orderRef = convParam ? null : params.get('order');
  const sellerParam = params.get('seller');
  const orderLookup = useQuery({
    queryKey: ['orders', 'list', { q: orderRef, limit: 5 }],
    queryFn: () => call(api.GET('/api/store/orders/orders', { params: { query: { q: orderRef!, limit: 5 } } })),
    enabled: !!orderRef,
  });
  const orderId = orderLookup.data?.items.find((o) => o.ref === orderRef)?.id ?? null;
  const orderConvs = useQuery({
    queryKey: ['messaging', 'conversations', 'order', orderId],
    queryFn: () => call(api.GET('/api/store/messaging/conversations', { params: { query: { orderId: orderId!, limit: 50 } } })),
    enabled: !!orderId,
  });
  const orderMatch = orderConvs.data ? (sellerParam ? orderConvs.data.items.find((t) => t.counterparty.id === sellerParam) : orderConvs.data.items[0]) : undefined;
  const compose = !!orderRef && orderConvs.isSuccess && !orderMatch;
  const orderSellers = useQuery({
    queryKey: ['messaging', 'order-sellers', orderId],
    queryFn: async () => {
      const o = await call(api.GET('/api/store/orders/orders/{id}', { params: { path: { id: orderId! } } }));
      return o.groups.map((g) => ({ id: g.seller.ownerType === 'official' ? OFFICIAL_STORE_ID : g.seller.id!, name: g.seller.name, official: g.seller.ownerType === 'official', label: g.packageLabel }));
    },
    enabled: compose,
  });
  const [to, setTo] = useState('');
  const recipient = orderSellers.data?.find((s) => s.id === (to || sellerParam)) ?? orderSellers.data?.[0];
  const orderNotFound = !!orderRef && orderLookup.isSuccess && !orderId;

  const activeId = convParam ?? (orderRef ? (orderMatch?.id ?? null) : (threads[0]?.id ?? null));
  const summary = threads.find((t) => t.id === activeId) ?? orderConvs.data?.items.find((t) => t.id === activeId);

  const conversation = useQuery({
    queryKey: ['messaging', 'conversation', activeId],
    queryFn: () => call(api.GET('/api/store/messaging/conversations/{id}', { params: { path: { id: activeId! } } })),
    enabled: !!activeId,
  });
  const messages = useInfiniteQuery({
    queryKey: ['messaging', 'messages', activeId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      call(api.GET('/api/store/messaging/conversations/{id}/messages', { params: { path: { id: activeId! }, query: { limit: 30, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!activeId,
  });
  // Newest first from the API; the log shows oldest first.
  const log: Message[] = (messages.data?.pages.flatMap((p) => p.items) ?? []).slice().reverse();
  const newest = messages.data?.pages[0]?.items[0];

  const markRead = useMutation({
    mutationFn: ({ id, upTo }: { id: string; upTo: string }) => call(api.POST('/api/store/messaging/conversations/{id}/read', { params: { path: { id } }, body: { upToMessageId: upTo } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['messaging', 'conversations'] }),
  });
  useEffect(() => {
    if (activeId && newest && summary?.unread && !markRead.isPending) markRead.mutate({ id: activeId, upTo: newest.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, newest?.id, summary?.unread]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newest?.id, activeId]);

  const send = useMutation({
    mutationFn: async ({ id, text, picks }: { id: string | null; text: string; picks: Pick[] }): Promise<string> => {
      const mediaIds: string[] = [];
      for (const p of picks) mediaIds.push((await uploadMedia(session, p.file, 'message_attachment', { alt: p.file.name })).id);
      clientMessageId.current ??= crypto.randomUUID();
      if (id) {
        await call(api.POST('/api/store/messaging/conversations/{id}/messages', { params: { path: { id } }, body: { body: text, mediaIds, clientMessageId: clientMessageId.current } }));
        return id;
      }
      // New conversation about the order (one per customer + seller + subject; the API reuses an existing one).
      if (!orderId || !recipient) throw new ApiError(400, 'NO_RECIPIENT', 'Choose who to message.');
      const started = await call(
        api.POST('/api/store/messaging/conversations', {
          body: { with: recipient.official ? 'official_store' : 'seller', orderId, sellerId: recipient.official ? null : recipient.id, body: text, mediaIds, clientMessageId: clientMessageId.current },
        }),
      );
      return started.conversation.id;
    },
    onSuccess: (id) => {
      clientMessageId.current = null;
      setDraft('');
      setFiles([]);
      void qc.invalidateQueries({ queryKey: ['messaging', 'messages', id] });
      void qc.invalidateQueries({ queryKey: ['messaging', 'conversations'] });
      if (id !== activeId) open(id, true);
    },
  });

  function open(id: string, keepDraft = false) {
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set('conversation', id);
        n.delete('order');
        n.delete('seller');
        return n;
      },
      { replace: true },
    );
    setPhoneList(false);
    if (!keepDraft) {
      setDraft('');
      setFiles([]);
      setFileMsg('');
      send.reset();
      clientMessageId.current = null;
    }
  }
  // ?order= with an existing conversation: switch the URL to that conversation.
  useEffect(() => {
    if (orderRef && orderMatch) open(orderMatch.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderRef, orderMatch?.id]);

  const c = conversation.data;
  const cp: Counterparty | undefined = c?.counterparty ?? summary?.counterparty ?? (compose && recipient ? { kind: recipient.official ? 'official_store' : 'seller', id: recipient.id, name: recipient.name, verified: !recipient.official } : undefined);
  const subject = c?.subject ?? summary?.subject ?? (compose && orderRef ? { kind: 'order' as const, orderId, orderRef, title: recipient ? `${recipient.label} from ${recipient.name}` : 'Your order' } : undefined);
  const canSend = compose ? !!recipient : c ? c.canSend && c.status === 'open' : false;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if ((!text && !files.length) || (!activeId && !compose) || !canSend || send.isPending) return;
    send.mutate({ id: compose ? null : activeId, text, picks: files });
  };
  const pickFiles = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    const tooBig = picked.filter((f) => f.size > MAX_ATTACHMENT_MB * 1024 * 1024);
    const ok = picked.filter((f) => f.size <= MAX_ATTACHMENT_MB * 1024 * 1024);
    const room = MAX_ATTACHMENTS - files.length;
    setFiles((fs) => [...fs, ...ok.slice(0, room).map((f, i) => ({ key: `${Date.now()}-${i}`, file: f }))]);
    setFileMsg(tooBig.length ? `Files can be up to ${MAX_ATTACHMENT_MB} MB.` : ok.length > room ? `Up to ${MAX_ATTACHMENTS} files per message.` : '');
    if (fileRef.current) fileRef.current.value = '';
  };
  const editDraft = (v: string) => {
    setDraft(v);
    clientMessageId.current = null;
    if (send.isError) send.reset();
  };

  const head = (
    <div className="acct-head">
      <div className="stack gap-1">
        <h1 className="h1 acct-h1">Messages</h1>
        <p className="small sub">Conversations about your orders. Promotions never appear here.</p>
      </div>
    </div>
  );

  if (inbox.isError) {
    return (
      <AccountLayout active="messages" title="Messages">
        {head}
        <Alert tone="danger" title="We couldn't load your messages">
          {errorMessage(inbox.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => void inbox.refetch()}>
            Try again
          </Button>
        </Alert>
      </AccountLayout>
    );
  }
  if (inbox.isSuccess && !threads.length && !query && !orderRef) {
    return (
      <AccountLayout active="messages" title="Messages">
        {head}
        <div className="card">
          <EmptyState icon="message-square" as="h2" title="No messages yet" action={<Button to={href('account/orders')}>Your orders</Button>}>
            To ask a seller about an order, open the order and choose Contact seller. Replies show up here.
          </EmptyState>
        </div>
      </AccountLayout>
    );
  }

  const sendError = send.error instanceof ApiError && send.error.code === 'CONVERSATION_LOCKED' ? 'This conversation is closed to new messages.' : send.error ? errorMessage(send.error) : '';
  let lastDay = '';

  return (
    <AccountLayout active="messages" title={phoneList || !cp ? 'Messages' : cp.name}>
      {head}
      <section className="card u-ov-hidden">
        <div className="acct-msgs">
          <div className={cx('inbox', !phoneList && 'no-phone')}>
            <div className="toolbar u-bb-1px-solid-border" style={{ padding: 'var(--sp-3)' }}>
              <SearchInput id="msg-q" placeholder="Search messages" value={q} onChange={setQ} label="Search messages" />
            </div>
            {inbox.isPending &&
              [0, 1, 2].map((i) => (
                <div key={i} className="sk-row u-p-sp-4" aria-hidden="true">
                  <span className="sk sk-thumb" />
                  <span className="sk-lines">
                    <span className="sk sk-line" />
                    <span className="sk sk-line short" />
                  </span>
                </div>
              ))}
            {threads.map((t) => (
              <a
                key={t.id}
                className={cx('acct-row', t.id === activeId && 'acct-active')}
                href="#"
                aria-current={t.id === activeId ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  open(t.id);
                }}
              >
                <ThreadLogo c={t.counterparty} md />
                <span className="stack gap-0 grow">
                  <span className="row between gap-2 nowrap">
                    <span className={cx('small truncate', t.unread ? 'bold' : 'strong')}>{t.counterparty.name}</span>
                    <span className="xs muted nowrap">{listTime(t.lastMessageAt)}</span>
                  </span>
                  <span className="xs muted truncate">{subjectLine(t.subject)}</span>
                  <span className="xs sub clamp-2">
                    {t.lastFromMe ? 'You: ' : ''}
                    {t.lastMessagePreview}
                  </span>
                </span>
                {t.unread && (
                  <>
                    <span className="acct-dot" aria-hidden="true" />
                    <span className="sr-only">Unread</span>
                  </>
                )}
              </a>
            ))}
            {inbox.isSuccess && threads.length === 0 && <p className="small muted u-p-sp-4">No conversations match "{q.trim()}".</p>}
            {inbox.hasNextPage && (
              <div className="u-p-sp-4">
                <Button variant="ghost" size="sm" onClick={() => void inbox.fetchNextPage()} disabled={inbox.isFetchingNextPage}>
                  {inbox.isFetchingNextPage ? 'Loading…' : 'Load more conversations'}
                </Button>
              </div>
            )}
          </div>
          <div className={cx('stack gap-0', phoneList && 'no-phone')}>
            <div className="row gap-3 between u-p-sp-3-sp-4 u-bb-1px-solid-border">
              <div className="row gap-3 nowrap min-w-0">
                {cp ? <ThreadLogo c={cp} /> : <span className="sk sk-thumb" aria-hidden="true" />}
                <div className="stack gap-0">
                  <span className="row gap-2">
                    <span className="strong">{cp?.name ?? ' '}</span>
                    {cp && cp.kind !== 'marketplace_support' && <SellerBadge seller={{ official: cp.kind === 'official_store', verified: !!cp.verified }} compact />}
                  </span>
                  <span className="xs muted">{cp ? counterpartyMeta(cp) || (c?.replyDue ? `Reply due ${listTime(c.replyDue.dueAt)}` : '') : ''}</span>
                </div>
              </div>
              <a
                className="small strong only-phone"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setPhoneList(true);
                }}
              >
                All messages
              </a>
            </div>
            {orderNotFound && (
              <div className="u-p-sp-4">
                <Alert tone="warning" title="We couldn't find that order">
                  Open the order from Orders and choose Contact seller.
                </Alert>
              </div>
            )}
            {(orderLookup.isError || orderConvs.isError || orderSellers.isError) && (
              <div className="u-p-sp-4">
                <Alert tone="danger" title="We couldn't open a conversation about this order">
                  {errorMessage(orderLookup.error ?? orderConvs.error ?? orderSellers.error)}
                </Alert>
              </div>
            )}
            {compose && (orderSellers.data?.length ?? 0) > 1 && (
              <div className="row gap-2 u-p-sp-3-sp-4 u-bb-1px-solid-border">
                <label className="small strong" htmlFor="msg-to">
                  To
                </label>
                <Select id="msg-to" ctl="sm" value={recipient?.id ?? ''} onChange={(e) => setTo(e.target.value)} options={orderSellers.data!.map((s) => ({ value: s.id, label: `${s.name} (${s.label})` }))} />
              </div>
            )}
            {compose && <p className="xs muted u-p-sp-3-sp-4">New conversation about order {orderRef}. Your first message starts it.</p>}
            {subject && (
              <Link className="acct-row u-bg-surface-2" to={aboutLink(subject)}>
                <Img icon="package" tint="2" className="tiny" src={subject.imageUrl ?? undefined} alt="" />
                <span className="stack gap-0 grow">
                  <span className="xs muted">
                    {aboutOf(subject).label} {aboutOf(subject).ref && <span className="mono">{aboutOf(subject).ref}</span>}
                    {aboutOf(subject).extra && ` · ${aboutOf(subject).extra}`}
                  </span>
                  <span className="small strong truncate">{subject.title}</span>
                </span>
                {subject.statusLabel && <Badge tone={statusTone(subject.statusLabel)}>{subject.statusLabel}</Badge>}
              </Link>
            )}
            <div ref={logRef} className="stack gap-3 u-p-sp-4" style={{ minHeight: '280px' }} aria-label="Conversation" role="log">
              {messages.hasNextPage && (
                <Button variant="ghost" size="sm" onClick={() => void messages.fetchNextPage()} disabled={messages.isFetchingNextPage}>
                  {messages.isFetchingNextPage ? 'Loading…' : 'Show earlier messages'}
                </Button>
              )}
              {(messages.isPending || conversation.isPending) && activeId && (
                <span className="stack gap-2" aria-hidden="true">
                  <span className="sk sk-line" />
                  <span className="sk sk-line short" />
                </span>
              )}
              {(messages.isError || conversation.isError) && (
                <Alert tone="danger" title="We couldn't load this conversation">
                  {errorMessage(messages.error ?? conversation.error)}{' '}
                  <Button variant="ghost" size="sm" onClick={() => void (messages.isError ? messages.refetch() : conversation.refetch())}>
                    Try again
                  </Button>
                </Alert>
              )}
              {log.map((m) => {
                const day = daySeparator(m.at);
                const sep = day !== lastDay;
                lastDay = day;
                return (
                  <Fragment key={m.id}>
                    {sep && <span className="acct-sys">{day}</span>}
                    {m.kind === 'system' ? (
                      <span className="acct-sys">{m.body}</span>
                    ) : (
                      <div className={cx('acct-bubble', m.fromMe && 'me')}>
                        {m.hidden ? <span className="muted">{m.hiddenReason ?? 'This message was hidden by Marketly.'}</span> : m.body && <span>{m.body}</span>}
                        {!m.hidden &&
                          m.attachments.map((a, i) => (
                            <span key={a.id} className="row gap-2 xs muted">
                              <Icon name="paperclip" className="ic-sm" />
                              <a href={a.url} target="_blank" rel="noreferrer">
                                {attachmentName(a, i)}
                              </a>
                            </span>
                          ))}
                        <span className="xs muted">
                          {m.fromMe ? 'You' : m.authorLabel} · {time(m.at)}
                        </span>
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
            {c && !canSend && (
              <p className="row gap-1 xs muted u-p-0-sp-4-sp-3">
                <Icon name="lock" className="ic-sm" />
                <span>{c.lockedReason ?? (c.status === 'archived' ? 'This conversation is archived. Start a new one from the order page.' : 'This conversation is closed to new messages.')}</span>
              </p>
            )}
            {files.map((f) => (
              <p key={f.key} className="row gap-1 xs muted u-p-0-sp-4-sp-3">
                <Icon name="paperclip" className="ic-sm" />
                <span>Attached: {f.file.name}</span>
                <IconButton icon="x" label={`Remove ${f.file.name}`} size="sm" onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))} />
              </p>
            ))}
            {(fileMsg || sendError) && (
              <p className="row gap-1 xs u-p-0-sp-4-sp-3" role="alert">
                <Icon name="circle-alert" className="ic-sm" />
                <span>{sendError || fileMsg}</span>
              </p>
            )}
            <form className="acct-composer" onSubmit={submit}>
              <IconButton icon="paperclip" label="Attach a photo or file" onClick={() => fileRef.current?.click()} disabled={!canSend || files.length >= MAX_ATTACHMENTS} />
              <input ref={fileRef} type="file" hidden multiple accept={ATTACHMENT_TYPES} onChange={(e) => pickFiles(e.target.files)} />
              <label className="sr-only" htmlFor="msg-text">
                Message to {cp?.name ?? 'the seller'}
              </label>
              <textarea
                className="textarea grow"
                id="msg-text"
                rows={1}
                placeholder="Write a message"
                style={{ minHeight: '44px' }}
                maxLength={MESSAGE_MAX_LENGTH}
                disabled={!canSend}
                value={draft}
                onChange={(e) => editDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              <Button type="submit" icon="send" disabled={!canSend || send.isPending || (!draft.trim() && !files.length)}>
                {send.isPending ? 'Sending…' : 'Send'}
              </Button>
            </form>
            <p className="xs muted u-p-0-sp-4-sp-3">
              {c?.rulesNote ?? 'Keep payments and contact details on Marketly. Support can read this thread if you open a case.'} Looking for offers? Manage promotions in{' '}
              <Link to={href('account/profile')} className="link-inline">
                notification preferences
              </Link>
              .
            </p>
          </div>
        </div>
      </section>
    </AccountLayout>
  );
}
