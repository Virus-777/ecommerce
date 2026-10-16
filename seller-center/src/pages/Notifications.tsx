import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { isoInText } from '@marketly/web-shared/lib/format';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href, type ScreenId } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Deadline, EmptyState, Icon, PageHeader, Switch } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { dayKey, deadlineLabel, deadlineTone, iconOf, LoadError, screenHref, shortDate, SkeletonLines, time, weekdayDate, date } from './data/home';

// Design: pages/seller/seller-notifications.html (no views).
// API: GET /api/seller/notifications/inbox (group, unreadOnly, cursor: "Load older notices"),
// GET …/inbox/summary (counts per group, needs action sorted by deadline), POST …/inbox/{id}/read,
// POST …/inbox/read-all, GET …/preferences (the essential-notices note). Times in Pacific Time.

type Notice = components['schemas']['notifications.Notice'];
type Group = 'orders' | 'returns_cases' | 'products' | 'account_finance';
type When = 'Today' | 'Earlier this week' | 'Older';

const CATS: Array<{ key: Group | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'orders', label: 'Orders' },
  { key: 'returns_cases', label: 'Returns & cases' },
  { key: 'products', label: 'Products' },
  { key: 'account_finance', label: 'Account & finance' },
];
const CAT_LABEL: Record<string, string> = { orders: 'Orders', returns_cases: 'Returns & cases', products: 'Products', account_finance: 'Account & finance' };
const WHEN: When[] = ['Today', 'Earlier this week', 'Older'];

function whenOf(iso: string, now = new Date()): When {
  if (dayKey(iso) === dayKey(now)) return 'Today';
  return now.getTime() - new Date(iso).getTime() < 7 * 86_400_000 ? 'Earlier this week' : 'Older';
}
const stamp = (iso: string, w: When) => (w === 'Today' ? time(iso) : w === 'Earlier this week' ? weekdayDate(iso) : date(iso));

/** Where the publishing module shows the record; the list screen when the link lacks what the detail screen needs. */
const FALLBACK: Partial<Record<string, ScreenId>> = {
  'seller/order': 'seller/orders',
  'seller/return': 'seller/returns',
  'seller/statement': 'seller/finance',
  'seller/help-article': 'seller/help',
};
function noticeHref(n: Notice): string | undefined {
  const l = n.link;
  return screenHref(l.screen, null, l.ref ? { ref: l.ref } : undefined) ?? (FALLBACK[l.screen] ? href(FALLBACK[l.screen]!) : undefined);
}

/** urgent = red edge + danger badge; action = amber edge + warning badge (open action notices only). */
function kindOf(n: Notice): 'urgent' | 'action' | undefined {
  if (!n.actionRequired || (n.state && n.state !== 'open')) return undefined;
  return n.deadline?.state === 'overdue' ? 'urgent' : 'action';
}

function NoticeDeadline({ n }: { n: Notice }) {
  if (n.state === 'resolved') return <Badge tone="success">Resolved {shortDate(n.resolvedAt ?? n.createdAt)}</Badge>;
  if (n.state === 'expired') return <Badge>No longer needed</Badge>;
  if (!n.deadline) return null;
  return <Deadline tone={deadlineTone(n.deadline.state)}>{deadlineLabel(n.deadline.dueAt)}</Deadline>;
}

/** The notice row: a link to its record, or a plain row when this app has no screen for it. */
function NoteLink({ n, className, onOpen, children }: { n: Notice; className: string; onOpen: () => void; children: ReactNode }) {
  const to = noticeHref(n);
  if (to) {
    return (
      <Link className={className} to={to} onClick={onOpen}>
        {children}
      </Link>
    );
  }
  return (
    <a
      className={className}
      href="#"
      onClick={(e) => {
        e.preventDefault();
        onOpen();
      }}
    >
      {children}
    </a>
  );
}

export default function Notifications() {
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  const qc = useQueryClient();
  const [cat, setCat] = useState<Group | 'all'>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [allRead, setAllRead] = useState(false);

  const summary = useQuery({ queryKey: ['notifications', 'summary', sellerId], queryFn: () => call(api.GET('/api/seller/notifications/inbox/summary')), refetchInterval: 60_000 });
  const prefs = useQuery({ queryKey: ['notifications', 'preferences', sellerId], queryFn: () => call(api.GET('/api/seller/notifications/preferences')), staleTime: 5 * 60_000 });
  const inbox = useInfiniteQuery({
    queryKey: ['notifications', 'inbox', sellerId, { group: cat, unreadOnly }],
    queryFn: ({ pageParam }) =>
      call(api.GET('/api/seller/notifications/inbox', { params: { query: { group: cat === 'all' ? undefined : cat, unreadOnly: unreadOnly || undefined, cursor: pageParam, limit: 24 } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const markRead = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/seller/notifications/inbox/{id}/read', { params: { path: { id } } })),
    onSuccess: () => void refresh(),
  });
  const markAll = useMutation({
    mutationFn: () => call(api.POST('/api/seller/notifications/inbox/read-all', { body: {} })),
    onSuccess: () => {
      setAllRead(true);
      void refresh();
    },
  });
  const open = (n: Notice) => {
    if (!n.readAt) markRead.mutate(n.id);
  };

  const s = summary.data;
  const notes = inbox.data?.pages.flatMap((p) => p.items) ?? [];
  const countOf = (k: Group | 'all') => (s ? (k === 'all' ? s.total : (s.totalByGroup[k] ?? 0)) : undefined);
  const actions = s?.needsAction ?? [];
  const now = new Date();

  return (
    <SellerLayout active="notifications">
      <PageHeader
        title="Notifications"
        sub={s ? `${s.unread} unread · ${s.actionRequired} need action. Times in Pacific Time.` : 'Times in Pacific Time.'}
        actions={
          <Button variant="secondary" size="sm" icon="check-check" onClick={() => markAll.mutate()} disabled={!s?.unread || markAll.isPending}>
            Mark all as read
          </Button>
        }
      />
      <div className="sb-main">
        <div className="stack gap-3">
          {allRead && !s?.unread && <Alert tone="success" title="All notices marked as read" />}
          {markAll.isError && (
            <Alert tone="danger" title="We couldn’t mark the notices as read">
              {errorMessage(markAll.error)}
            </Alert>
          )}
          <div className="row between">
            <div className="hscroll gap-2">
              {CATS.map((c) => {
                const n = countOf(c.key);
                return (
                  <a
                    key={c.key}
                    className={cx('chip', cat === c.key && 'is-active')}
                    href="#"
                    aria-current={cat === c.key ? 'true' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      setCat(c.key);
                    }}
                  >
                    {c.label}
                    {n !== undefined && ` (${n})`}
                  </a>
                );
              })}
            </div>
            <Switch id="nt-unread" label="Unread only" checked={unreadOnly} aria-checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          </div>
          <section className="card">
            {inbox.isPending ? (
              <div className="card-body">
                <SkeletonLines rows={5} />
              </div>
            ) : inbox.isError ? (
              <div className="card-body">
                <LoadError error={inbox.error} onRetry={() => void inbox.refetch()} />
              </div>
            ) : notes.length === 0 ? (
              <div className="card-body">
                <EmptyState icon="bell" title={unreadOnly ? 'No unread notices' : 'No notices here'}>
                  {unreadOnly ? 'You’re all caught up. Turn off Unread only to see earlier notices.' : 'Notices for this category will appear here.'}
                </EmptyState>
              </div>
            ) : (
              WHEN.map((g) => {
                const items = notes.filter((n) => whenOf(n.createdAt, now) === g);
                if (!items.length) return null;
                return [
                  <div key={g} className="sb-grp">
                    {g}
                  </div>,
                  ...items.map((n) => {
                    const kind = kindOf(n);
                    const unread = !n.readAt;
                    return (
                      <NoteLink key={n.id} n={n} className={cx('sb-note', unread && 'is-unread', kind && `is-${kind}`)} onOpen={() => open(n)}>
                        {kind === 'urgent' && <span className="sr-only">Urgent: </span>}
                        {kind === 'action' && <span className="sr-only">Needs action: </span>}
                        <span className="ic">
                          <Icon name={iconOf(n.icon)} />
                        </span>
                        <span className="stack gap-1">
                          <span className="row gap-2">
                            {unread && (
                              <>
                                <span className="dot" aria-hidden="true" />
                                <span className="sr-only">Unread.</span>
                              </>
                            )}
                            <span className={unread ? 'small bold' : 'small strong'}>{isoInText(n.title)}</span>
                          </span>
                          <span className="xs sub">{isoInText(n.body)}</span>
                          <span className="row gap-2">
                            {CAT_LABEL[n.group] && <Badge tone="outline">{CAT_LABEL[n.group]}</Badge>}
                            {kind && (
                              <Badge tone={kind === 'urgent' ? 'danger' : 'warning'} icon="triangle-alert">
                                Action required
                              </Badge>
                            )}
                            <NoticeDeadline n={n} />
                          </span>
                        </span>
                        <span className="side">
                          <span className="xs muted nowrap">{stamp(n.createdAt, g)}</span>
                          <Icon name="chevron-right" className="ic-sm" />
                        </span>
                      </NoteLink>
                    );
                  }),
                ];
              })
            )}
            <div className="card-foot">
              <span className="xs muted grow">Notices are kept for 12 months.</span>
              {inbox.hasNextPage && (
                <Button variant="ghost" size="sm" onClick={() => void inbox.fetchNextPage()} disabled={inbox.isFetchingNextPage}>
                  {inbox.isFetchingNextPage ? 'Loading…' : 'Load older notices'}
                </Button>
              )}
            </div>
          </section>
        </div>
        <div className="stack gap-5">
          <Card title="Needs action" sub="Sorted by deadline">
            {summary.isPending ? (
              <SkeletonLines rows={2} />
            ) : summary.isError ? (
              <LoadError error={summary.error} onRetry={() => void summary.refetch()} />
            ) : actions.length === 0 ? (
              <p className="small sub">Nothing needs action right now.</p>
            ) : (
              <ul className="list">
                {actions.map((n) => {
                  const to = noticeHref(n);
                  return (
                    <li key={n.id}>
                      <span className="grow stack gap-0">
                        {to ? (
                          <Link className="small strong" to={to} onClick={() => open(n)}>
                            {n.title}
                          </Link>
                        ) : (
                          <span className="small strong">{isoInText(n.title)}</span>
                        )}
                        <NoticeDeadline n={n} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title="Email notifications" titleAs="h3">
            <p className="small sub">Choose which notices each person also gets by email.</p>
            <Link className="small strong" to={href('seller/staff')}>
              <Icon name="settings" className="ic-sm" /> Notification preferences
            </Link>
            <Alert tone="info" title="Essential notices can’t be turned off">
              {prefs.data?.essentialNote ?? 'New orders, dispatch deadlines, return and case deadlines, restrictions, payout results and security alerts always appear here and are always emailed to the owner.'}
            </Alert>
          </Card>
        </div>
      </div>
    </SellerLayout>
  );
}
