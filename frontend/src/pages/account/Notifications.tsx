import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { isoInText } from '@marketly/web-shared/lib/format';
import { cx } from '@marketly/web-shared/lib/cx';
import { href, SCREEN_BY_ID, type ScreenId } from '@marketly/web-shared/routes';
import { Alert, announce, Button, Chip, ChipRow, Icon, IconButton, iconFor, type IconName } from '@marketly/web-shared/ui';
import { ageGroup, listTime } from './data/when';

// Design: pages/store/account-notifications.html (one view). Chips filter by inbox group; opening an
// item marks it read; "Mark all as read" clears the unread dots. Notices can be archived one by one or all
// read ones at once ("Archive read"); "Archived" lists them (?archived=true). Open action notices can't be
// archived until their work is done (409 NOTICE_ACTION_OPEN).
// API: notifications inbox (GET /api/store/notifications/inbox, POST …/inbox/{id}/read, POST …/inbox/read-all,
// POST …/inbox/{id}/archive, POST …/inbox/archive-all).

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

/** Notices stored before notice links carried their refs (G27) can lack the ref: those open the list screen. */
const FALLBACK: Partial<Record<string, ScreenId>> = {
  'account/order': 'account/orders',
  'account/tracking': 'account/orders',
  'account/cancel': 'account/orders',
  'account/return': 'account/returns',
  'help/case': 'help/cases',
};
const REF_PREFIX: Partial<Record<string, string>> = { 'account/order': 'MK-', 'account/tracking': 'MK-', 'account/cancel': 'MK-', 'account/return': 'RT-', 'help/case': 'CS-' };

/** App route for a NoticeLink: the record's screen with its ref (a package's tracking also gets ?shipment=<id>). */
function linkOf(n: Notice): string {
  const l = n.link;
  if (l.url) return l.url;
  const screen = l.screen as ScreenId;
  if (!SCREEN_BY_ID[screen]) return href('account/notifications');
  if (!SCREEN_BY_ID[screen].path.includes(':ref')) return href(screen);
  const prefix = REF_PREFIX[screen];
  if (!l.ref || (prefix && !l.ref.startsWith(prefix))) return href(FALLBACK[screen] ?? 'account/overview');
  return href(screen, '', { ref: l.ref }, l.kind === 'shipment' && screen === 'account/tracking' ? { shipment: l.id } : undefined);
}

/** An action notice whose work is still open: the API refuses to archive it (NOTICE_ACTION_OPEN). */
const actionOpen = (n: Notice) => n.actionRequired && n.state === 'open';

export default function Notifications() {
  const { api } = useApi();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'' | Group>('');
  const [archived, setArchived] = useState(false);
  const key = ['notifications', 'inbox', filter || 'all', archived ? 'archived' : 'inbox'];

  const inbox = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      call(api.GET('/api/store/notifications/inbox', { params: { query: { ...(filter ? { group: filter } : {}), ...(archived ? { archived: true } : {}), limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } } })),
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
  const drop = (id: string) =>
    qc.setQueriesData<InfiniteData<Page>>({ queryKey: ['notifications', 'inbox'] }, (d) => (d ? { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.filter((n) => n.id !== id) })) } : d));
  const archive = useMutation({
    mutationFn: (n: Notice) => call(api.POST('/api/store/notifications/inbox/{id}/archive', { params: { path: { id: n.id } } })),
    onSuccess: (_r, n) => {
      drop(n.id);
      announce('Notification archived');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const archiveRead = useMutation({
    mutationFn: () => call(api.POST('/api/store/notifications/inbox/archive-all', { body: { ...(filter ? { group: filter } : {}), readOnly: true } })),
    onSuccess: (r) => announce(r.updated ? `Archived ${r.updated} read notifications` : 'No read notifications to archive'),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const archiveError =
    archive.error instanceof ApiError && archive.error.code === 'NOTICE_ACTION_OPEN'
      ? 'This notification still needs your action. You can archive it once that’s done.'
      : archive.error
        ? errorMessage(archive.error)
        : archiveRead.error
          ? errorMessage(archiveRead.error)
          : null;

  const notes = inbox.data?.pages.flatMap((p) => p.items) ?? [];
  const essential = notes.filter((n) => n.category === 'essential');
  const promo = notes.filter((n) => n.category !== 'essential');
  const unread = notes.filter((n) => !n.readAt).length;

  const row = (n: Notice) => {
    const to = linkOf(n);
    const inner = (
      <>
        <span className={cx('acct-ic', n.tone && n.tone !== 'neutral' && `t-${n.tone}`)}>
          <Icon name={iconFor(n.icon)} className="ic-sm" />
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
    const open = /^https?:/.test(to) ? (
      <a className="acct-row grow" href={to} onClick={onOpen}>
        {inner}
      </a>
    ) : (
      <Link className="acct-row grow" to={to} onClick={onOpen}>
        {inner}
      </Link>
    );
    return (
      <div key={n.id} className="row nowrap gap-0">
        {open}
        {!archived && (
          <IconButton
            icon="x"
            size="sm"
            label={actionOpen(n) ? `${n.title}: needs your action before it can be archived` : `Archive: ${n.title}`}
            disabled={actionOpen(n) || (archive.isPending && archive.variables?.id === n.id)}
            onClick={() => archive.mutate(n)}
          />
        )}
      </div>
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
          {!archived && (
            <>
              <Button variant="ghost" size="sm" icon="check" onClick={() => markAll.mutate()} disabled={unread === 0 || markAll.isPending}>
                Mark all as read
              </Button>
              <Button variant="ghost" size="sm" icon="x" onClick={() => archiveRead.mutate()} disabled={archiveRead.isPending || notes.every((n) => !n.readAt)}>
                Archive read
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" icon={archived ? 'bell' : 'inbox'} onClick={() => setArchived((a) => !a)} aria-pressed={archived}>
            {archived ? 'Back to inbox' : 'Archived'}
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
      {archiveError && (
        <Alert tone="warning" title="Couldn't archive">
          {archiveError}
        </Alert>
      )}
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
                <h2 className="h3">{archived ? 'No archived notifications' : 'Nothing here yet'}</h2>
                <p className="small muted measure-md">{archived ? 'Notifications you archive are kept here until they expire.' : 'Notifications in this category will appear here.'}</p>
              </div>
            </div>
          )}
        </>
      )}
    </AccountLayout>
  );
}
