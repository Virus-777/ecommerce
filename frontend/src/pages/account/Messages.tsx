import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { href } from '@/routes/href';
import { Badge, Button, Icon, IconButton, Img, LogoTile, SearchInput, SellerBadge } from '@/ui';
import { THREADS, type Thread } from './data/messages';

// Design: pages/store/account-messages.html (one view): inbox + the open conversation.
// On the phone (Android app) the conversation fills the screen; "All messages" shows the inbox.

function ThreadLogo({ t, md }: { t: Thread; md?: boolean }) {
  if (t.icon) {
    return (
      <span className={cx('logo-tile', `tint-${t.tint}`)} style={{ width: '36px', height: '36px', fontSize: '13px' } as CSSProperties} aria-hidden="true">
        <Icon name={t.icon} className="ic-sm" />
      </span>
    );
  }
  return <LogoTile initials={t.initials ?? ''} tint={t.tint} size={md ? 'md' : undefined} />;
}

function aboutLink(t: Thread) {
  if (t.about.ref.startsWith('RT-')) return href('account/return', '', { ref: t.about.ref });
  if (t.about.ref.startsWith('CS-')) return href('help/case', '', { ref: t.about.ref });
  return href('account/order', '', { ref: t.about.ref });
}

export default function Messages() {
  const [threads, setThreads] = useState<Thread[]>(THREADS);
  const [activeId, setActiveId] = useState(THREADS[0].id);
  const [q, setQ] = useState('');
  const [phoneList, setPhoneList] = useState(false);
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const active = threads.find((t) => t.id === activeId) ?? threads[0];
  const s = q.trim().toLowerCase();
  const shown = s ? threads.filter((t) => [t.name, t.subject, t.preview].some((x) => x.toLowerCase().includes(s))) : threads;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active.entries.length, activeId]);

  const open = (id: string) => {
    setActiveId(id);
    setPhoneList(false);
    setDraft('');
    setFile(null);
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, unread: false } : t)));
  };

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text && !file) return;
    setThreads((ts) =>
      ts.map((t) =>
        t.id === active.id
          ? {
              ...t,
              time: 'Now',
              preview: text || file || '',
              entries: [...t.entries, ...(t.entries.some((x) => x.kind === 'sys' && x.text === 'Today') ? [] : [{ kind: 'sys' as const, text: 'Today' }]), { kind: 'msg' as const, me: true, text, by: 'You', at: 'Just now', file: file ?? undefined }],
            }
          : t,
      ),
    );
    setDraft('');
    setFile(null);
  };

  return (
    <AccountLayout active="messages" title={phoneList ? 'Messages' : active.name}>
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Messages</h1>
          <p className="small sub">Conversations about your orders. Promotions never appear here.</p>
        </div>
      </div>
      <section className="card u-ov-hidden">
        <div className="acct-msgs">
          <div className={cx('inbox', !phoneList && 'no-phone')}>
            <div className="toolbar u-bb-1px-solid-border" style={{ padding: 'var(--sp-3)' }}>
              <SearchInput id="msg-q" placeholder="Search messages" value={q} onChange={setQ} label="Search messages" />
            </div>
            {shown.map((t) => (
              <a
                key={t.id}
                className={cx('acct-row', t.id === active.id && 'acct-active')}
                href="#"
                aria-current={t.id === active.id ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  open(t.id);
                }}
              >
                <ThreadLogo t={t} md />
                <span className="stack gap-0 grow">
                  <span className="row between gap-2 nowrap">
                    <span className={cx('small truncate', t.unread ? 'bold' : 'strong')}>{t.name}</span>
                    <span className="xs muted nowrap">{t.time}</span>
                  </span>
                  <span className="xs muted truncate">{t.subject}</span>
                  <span className="xs sub clamp-2">{t.preview}</span>
                </span>
                {t.unread && (
                  <>
                    <span className="acct-dot" aria-hidden="true" />
                    <span className="sr-only">Unread</span>
                  </>
                )}
              </a>
            ))}
            {shown.length === 0 && <p className="small muted u-p-sp-4">No conversations match "{q.trim()}".</p>}
          </div>
          <div className={cx('stack gap-0', phoneList && 'no-phone')}>
            <div className="row gap-3 between u-p-sp-3-sp-4 u-bb-1px-solid-border">
              <div className="row gap-3 nowrap min-w-0">
                <ThreadLogo t={active} />
                <div className="stack gap-0">
                  <span className="row gap-2">
                    <span className="strong">{active.name}</span>
                    {!active.icon && <SellerBadge seller={active} compact />}
                  </span>
                  <span className="xs muted">{active.meta}</span>
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
            <Link className="acct-row u-bg-surface-2" to={aboutLink(active)}>
              <Img icon={active.about.icon} tint={active.about.tint} className="tiny" />
              <span className="stack gap-0 grow">
                <span className="xs muted">
                  {active.about.label} <span className="mono">{active.about.ref}</span>
                  {active.about.extra && ` · ${active.about.extra}`}
                </span>
                <span className="small strong truncate">{active.about.product}</span>
              </span>
              <Badge tone={active.about.tone}>{active.about.status}</Badge>
            </Link>
            <div ref={logRef} className="stack gap-3 u-p-sp-4" style={{ minHeight: '280px' }} aria-label="Conversation" role="log">
              {active.entries.map((m, i) =>
                m.kind === 'sys' ? (
                  <span key={i} className="acct-sys">
                    {m.text}
                  </span>
                ) : (
                  <div key={i} className={cx('acct-bubble', m.me && 'me')}>
                    {m.text && <span>{m.text}</span>}
                    {m.file && (
                      <span className="row gap-2 xs muted">
                        <Icon name="paperclip" className="ic-sm" />
                        <a href="#">{m.file}</a>
                      </span>
                    )}
                    <span className="xs muted">
                      {m.by} · {m.at}
                    </span>
                  </div>
                ),
              )}
            </div>
            {file && (
              <p className="row gap-1 xs muted u-p-0-sp-4-sp-3">
                <Icon name="paperclip" className="ic-sm" />
                <span>Attached: {file}</span>
                <IconButton icon="x" label={`Remove ${file}`} size="sm" onClick={() => setFile(null)} />
              </p>
            )}
            <form className="acct-composer" onSubmit={send}>
              <IconButton icon="paperclip" label="Attach a photo or file" onClick={() => fileRef.current?.click()} />
              <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,application/pdf" onChange={(e) => setFile(e.target.files?.[0]?.name ?? null)} />
              <label className="sr-only" htmlFor="msg-text">
                Message to {active.name}
              </label>
              <textarea
                  className="textarea grow"
                  id="msg-text"
                  rows={1}
                  placeholder="Write a message"
                  style={{ minHeight: '44px' }}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
              <Button type="submit" icon="send">
                Send
              </Button>
            </form>
            <p className="xs muted u-p-0-sp-4-sp-3">
              Keep payments and contact details on Marketly. Support can read this thread if you open a case. Looking for offers? Manage promotions in{' '}
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
