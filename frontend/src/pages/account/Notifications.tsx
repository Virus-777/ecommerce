import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { isoInText } from '@marketly/web-shared/lib/format';
import { cx } from '@marketly/web-shared/lib/cx';
import { href, SCREEN_BY_ID, type ScreenId } from '@marketly/web-shared/routes';
import { Alert, announce, Button, Chip, ChipRow, Icon, type IconName } from '@marketly/web-shared/ui';
import { ageGroup, listTime } from './data/when';

// Design: pages/store/account-notifications.html (one view). Chips filter by inbox group; opening an
// item marks it read; "Mark all as read" clears the unread dots.
// API: notifications inbox (GET /api/store/notifications/inbox, POST …/inbox/{id}/read, POST …/inbox/read-all).

type Notice = components['schemas']['notifications.Notice'];
type Group = 'orders' | 'returns_refunds' | 'cases' | 'account' | 'promotions';
type Page = { items: Notice[]; nextCursor: string | null };

const FILTERS: Array<{ value: '' | Group; label: string; icon?: IconName }> = [
  { value: '', label: 'All' },
  { value: 'orders', label: 'Orders', icon: 'package' },
  { value: 'returns_refunds', label: 'Returns & refunds', icon: 'undo-2' },
  { value: 'cases', label: 'Cases', icon: 'life-buoy' },
  { value: 'account', label: 'Account', icon: 'shield-check' },
  { value: 'promotions', label: 'Promotions', icon: 'tag' },
];
const GROUP_LABEL: Record<string, string> = { orders: 'Orders', returns_refunds: 'Returns & refunds', cases: 'Cases', account: 'Account', promotions: 'Promotions' };

/** Icon names the API sends that the design's icon set spells differently. */
const ICON_ALIAS: Record<string, IconName> = { 'alert-triangle': 'triangle-alert', 'x-circle': 'circle-x', 'check-circle': 'circle-check', 'alert-circle': 'circle-alert', 'help-circle': 'circle-help', 'minus-circle': 'circle-minus' };
/** Customer topic icons that exist in the design's icon set; anything else shows the bell. */
const KNOWN_ICONS = new Set<IconName>([
  'truck', 'shopping-bag', 'package', 'package-check', 'wallet', 'search', 'rotate-ccw', 'tag', 'clock', 'shield-check', 'life-buoy', 'message-square',
  'circle-check', 'triangle-alert', 'circle-x', 'circle-alert', 'circle-help', 'credit-card', 'star', 'lock', 'mail', 'heart', 'percent', 'calendar',
  'file-text', 'download', 'flag', 'smartphone', 'store', 'sparkles', 'send', 'paperclip', 'log-out', 'undo-2', 'trending-down', 'bell',
]);
function iconOf(n: Notice): IconName {
  const name = (n.icon && (ICON_ALIAS[n.icon] ?? n.icon)) as IconName | null;
  return name && KNOWN_ICONS.has(name) ? name : 'bell';
}

/** Where a list screen is the closest target when the record's own screen can't be built from the link. */
const FALLBACK: Partial<Record<string, ScreenId>> = {
  'account/order': 'account/orders',
  'account/tracking': 'account/orders',
  'account/cancel': 'account/orders',
  'account/return': 'account/returns',
  'help/case': 'help/cases',
};
const REF_PREFIX: Partial<Record<string, string>> = { 'account/order': 'MK-', 'account/tracking': 'MK-', 'account/cancel': 'MK-', 'account/return': 'RT-', 'help/case': 'CS-' };

/** App route for a NoticeLink: the record's screen with its ref, or the list screen when the link lacks the ref. */
function linkOf(n: Notice): string {
  const l = n.link;
  if (l.url) return l.url;
  const screen = l.screen as ScreenId;
  if (!SCREEN_BY_ID[screen]) return href('account/notifications');
  const needsRef = SCREEN_BY_ID[screen].path.includes(':ref');
  if (!needsRef) return href(screen);
  const prefix = REF_PREFIX[screen];
  if (l.ref && (!prefix || l.ref.startsWith(prefix))) return href(screen, '', { ref: l.ref });
  return href(FALLBACK[screen] ?? 'account/overview');
}

export default function Notifications() {
  const { api } = useApi();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'' | Group>('');
  const key = ['notifications', 'inbox', filter || 'all'];

  const inbox = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      call(api.GET('/api/store/notifications/inbox', { params: { query: { ...(filter ? { group: filter } : {}), limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    getNextPageParam: (last) => last.nextCursor,
  });

  const patch = (fn: (n: Notice) => Notice) =>
    qc.setQueriesData<InfiniteData<Page>>({ queryKey: ['notifications', 'inbox'] }, (d) => (d ? { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.map(fn) })) } : d));

  const markRead = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/store/notifications/inbox/{id}/read', { params: { path: { id } } })),
    onMutate: (id) => patch((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['notifications', 'summary'] }),
  });
  const markAll = useMutation({
    mutationFn: () => call(api.POST('/api/store/notifications/inbox/read-all', { body: filter ? { group: filter } : {} })),
    onSuccess: () => {
      const now = new Date().toISOString();
      patch((n) => (!n.readAt && (!filter || n.group === filter) ? { ...n, readAt: now } : n));
      announce('All notifications marked as read');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const notes = inbox.data?.pages.flatMap((p) => p.items) ?? [];
  const essential = notes.filter((n) => n.category === 'essential');
  const promo = notes.filter((n) => n.category !== 'essential');
  const unread = notes.filter((n) => !n.readAt).length;

  const row = (n: Notice) => {
    const to = linkOf(n);
    const inner = (
      <>
        <span className={cx('acct-ic', n.tone && n.tone !== 'neutral' && `t-${n.tone}`)}>
          <Icon name={iconOf(n)} className="ic-sm" />
        </span>
        <span className="stack gap-1 grow">
          <span className="row between gap-2 top">
            <span className={cx('small', !n.readAt && 'bold')}>{isoInText(n.title)}</span>
            <span className="xs muted nowrap">{listTime(n.createdAt)}</span>
          </span>
          <span className="xs sub">{isoInText(n.body)}</span>
          <span className="xs muted">
            {GROUP_LABEL[n.group] ?? n.group}
            {n.link.ref && (
              <>
                {' '}· <span className="mono">{n.link.ref}</span>
              </>
            )}
          </span>
        </span>
        {!n.readAt && (
          <>
            <span className="acct-dot" aria-hidden="true" />
            <span className="sr-only">Unread</span>
          </>
        )}
      </>
    );
    const onOpen = () => !n.readAt && markRead.mutate(n.id);
    return /^https?:/.test(to) ? (
      <a key={n.id} className="acct-row" href={to} onClick={onOpen}>
        {inner}
      </a>
    ) : (
      <Link key={n.id} className="acct-row" to={to} onClick={onOpen}>
        {inner}
      </Link>
    );
  };

  return (
    <AccountLayout active="notifications" title="Notifications">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Notifications</h1>
          <p className="small sub">Updates about your orders, returns, cases and account. We also email the important ones.</p>
        </div>
        <div className="acts">
          <Button variant="ghost" size="sm" icon="check" onClick={() => markAll.mutate()} disabled={unread === 0 || markAll.isPending}>
            Mark all as read
          </Button>
          <Button variant="secondary" size="sm" icon="settings" to={href('account/profile')}>
            Notification settings
          </Button>
        </div>
      </div>
      <ChipRow>
        {FILTERS.map((f) => (
          <Chip key={f.value || 'all'} active={filter === f.value} icon={f.icon} onClick={() => setFilter(f.value)}>
            {f.label}
          </Chip>
        ))}
      </ChipRow>
      {markAll.isError && <Alert tone="danger" title="Couldn't mark them as read">{errorMessage(markAll.error)}</Alert>}
      {inbox.isError ? (
        <Alert tone="danger" title="We couldn't load your notifications">
          {errorMessage(inbox.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => void inbox.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : inbox.isPending ? (
        <div className="card sk-list" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div className="sk-row" key={i}>
              <span className="sk sk-thumb" />
              <span className="sk-lines">
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <>
          {essential.length > 0 && (
            <section className="stack gap-3" aria-labelledby="nt-ess">
              <div className="row between">
                <h2 className="h3" id="nt-ess">
                  Order and account updates
                </h2>
                <span className="row gap-1 xs muted">
                  <Icon name="lock" className="ic-sm" /> Always on
                </span>
              </div>
              {(['Today', 'This week', 'Earlier'] as const).map((g) => {
                const list = essential.filter((n) => ageGroup(n.createdAt) === g);
                if (!list.length) return null;
                return (
                  <Fragment key={g}>
                    <h3 className="eyebrow">{g}</h3>
                    <div className="card">{list.map(row)}</div>
                  </Fragment>
                );
              })}
            </section>
          )}
          {promo.length > 0 && (
            <section className="stack gap-3" aria-labelledby="nt-promo">
              <div className="row between">
                <h2 className="h3" id="nt-promo">
                  Promotions and alerts
                </h2>
                <Link className="xs strong" to={href('account/profile')}>
                  Turn off promotions
                </Link>
              </div>
              <div className="card">{promo.map(row)}</div>
            </section>
          )}
          {inbox.hasNextPage && (
            <Button variant="secondary" onClick={() => void inbox.fetchNextPage()} disabled={inbox.isFetchingNextPage}>
              {inbox.isFetchingNextPage ? 'Loading…' : 'Show older notifications'}
            </Button>
          )}
          {notes.length === 0 && (
            <div className="card">
              <div className="empty">
                <span className="ring">
                  <Icon name="bell-off" />
                </span>
                <h2 className="h3">Nothing here yet</h2>
                <p className="small muted measure-md">Notifications in this category will appear here.</p>
              </div>
            </div>
          )}
        </>
      )}
    </AccountLayout>
  );
}
