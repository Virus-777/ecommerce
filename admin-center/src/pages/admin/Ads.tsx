import { Fragment, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Chip, Dialog, EmptyState, Icon, IconButton, PageHeader, sameOriginFile, TableWrap, Tabs, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { actorLabel, LoadError, SkeletonLines } from '@/app/parts';
import { useDragSort } from './data/departments';
import { ADS_KEY, adHref, adReviewHref, AdStatusBadges, kindChip, scheduleText, sizeText, slotOf, slotsOfTab, TABS, type AdStatus, type SlotTab, type StaffAd, type StaffAdsPage } from './data/staff-ads';

// Admin › Marketing and content › Advertisements (designed from the Marketly canvas: AdminAds). Staff ads by where they
// show: Full-screen | Home carousel | Departments (Softwares, Food delivery, Companies, Play center) | Deals | Other
// (category banner, pop-up). Each tab has its slot card (size, rotation, Add … ad preset to the slot), status chips
// and the ads in carousel order. Data: GET /api/admin/advertising/ads?placement=<keys>; reorder PUT /ads/order (live
// and scheduled ads of one slot, drag the handle or use the arrow keys on it); row menu POST /ads/{id}/pause|resume|
// end|duplicate and DELETE /ads/{id} from the ad's allowedActions. ?placement=<key> opens that slot (department pages
// link here). The placements page (rules per slot) stays reachable as Slot settings.

type StatusFilter = 'all' | 'live' | 'scheduled' | 'paused' | 'review' | 'drafts' | 'ended';
const STATUS_FILTERS: Array<{ value: StatusFilter; label: string; statuses: AdStatus[] }> = [
  { value: 'all', label: 'All', statuses: [] },
  { value: 'live', label: 'Live', statuses: ['live'] },
  { value: 'scheduled', label: 'Scheduled', statuses: ['scheduled'] },
  { value: 'paused', label: 'Paused', statuses: ['paused'] },
  { value: 'review', label: 'Waiting for review', statuses: ['in_review'] },
  { value: 'drafts', label: 'Drafts', statuses: ['draft', 'changes_requested'] },
  { value: 'ended', label: 'Ended', statuses: ['ended', 'rejected'] },
];
type MenuAction = 'pause' | 'resume' | 'end' | 'duplicate' | 'delete';
const MENU: Array<{ action: MenuAction; label: string; icon: IconName }> = [
  { action: 'pause', label: 'Pause', icon: 'pause' },
  { action: 'resume', label: 'Resume', icon: 'play' },
  { action: 'end', label: 'End now', icon: 'circle-x' },
  { action: 'duplicate', label: 'Duplicate', icon: 'copy' },
  { action: 'delete', label: 'Delete draft', icon: 'trash' },
];
const DONE: Record<MenuAction, string> = { pause: 'paused: it leaves the app within a minute', resume: 'resumed', end: 'ended', duplicate: 'copied into a new draft', delete: 'deleted' };
const LIVE_ORDER: AdStatus[] = ['live', 'scheduled'];

/** How a slot's ads take turns, from Slot settings: "each ad shows 6 s, in this order · up to 10 live" */
function slotNote(s?: StaffAdsPage['slots'][string]): string {
  if (!s) return '';
  if (s.carouselSeconds) return `each ad shows ${s.carouselSeconds} s, in this order${s.maxLive ? ` · up to ${s.maxLive} live` : ''}`;
  const label = s.rotationLabel.replace(/ on Advertisements$/, '');
  return label ? label[0]!.toLowerCase() + label.slice(1) : '';
}


export default function Ads() {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useStaffSession();
  const canView = can('advertising.campaigns.view') || can('advertising.campaigns.manage') || can('advertising.campaigns.review');
  const canManage = can('advertising.campaigns.manage');
  const [params, setParams] = useSearchParams();
  const asked = slotOf(params.get('placement'));
  const tab = (TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : (asked?.tab ?? 'home')) as SlotTab;
  const slots = slotsOfTab(tab);
  const one = asked && asked.tab === tab ? asked : slots.length === 1 ? slots[0] : undefined;
  const keys = one ? [one.key] : slots.map((s) => s.key);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [notice, setNotice] = useState((useLocation().state as { notice?: string } | null)?.notice ?? '');
  const [error, setError] = useState('');
  const [menuFor, setMenuFor] = useState<StaffAd | null>(null);
  const [confirm, setConfirm] = useState<{ ad: StaffAd; action: 'end' | 'delete' } | null>(null);

  const goTab = (t: SlotTab) => {
    setStatus('all');
    setParams({ tab: t }, { replace: true });
  };
  const goSlot = (key: string) => {
    setStatus('all');
    setParams(key ? { tab, placement: key } : { tab }, { replace: true });
  };

  const queryKey = [...ADS_KEY, keys.join(',')];
  const list = useQuery({ queryKey, enabled: canView, queryFn: () => call(api.GET('/api/admin/advertising/ads', { params: { query: { placement: keys.join(',') } } })) });
  const page = list.data;
  const items = page?.items ?? [];
  const byId = new Map(items.map((a) => [a.id, a]));
  const counts = page?.counts ?? {};
  const statusCount = (f: (typeof STATUS_FILTERS)[number]) => (f.value === 'all' ? items.length : f.statuses.reduce((n, s) => n + (page?.statusCounts[s] ?? 0), 0));
  const filter = STATUS_FILTERS.find((f) => f.value === status)!;
  const shownItems = status === 'all' ? items : items.filter((a) => filter.statuses.includes(a.status));
  // live and scheduled ads of one slot keep a carousel order (they come first, in position order)
  const canOrder = canManage && !!one && status === 'all';
  const ordered = shownItems.filter((a) => LIVE_ORDER.includes(a.status));
  const rest = shownItems.filter((a) => !LIVE_ORDER.includes(a.status));

  const order = useMutation({
    mutationFn: (ids: string[]) => call(api.PUT('/api/admin/advertising/ads/order', { body: { placementKey: one!.key, ids } })),
    onSuccess: (d) => qc.setQueryData(queryKey, d),
    onError: (e) => {
      setError(`The new order wasn’t saved: ${errorMessage(e)}`);
      void qc.invalidateQueries({ queryKey: ADS_KEY });
    },
  });
  const sort = useDragSort({
    keys: ordered.map((a) => a.id),
    disabled: !canOrder || order.isPending,
    onSort: (ids, moved) => {
      qc.setQueryData(queryKey, (d: StaffAdsPage | undefined) => d && { ...d, items: [...ids.map((id, i) => ({ ...byId.get(id)!, position: i + 1 })), ...d.items.filter((a) => !ids.includes(a.id))] });
      setError('');
      setNotice('');
      order.mutate(ids);
      announce(`${byId.get(moved)?.name ?? 'Ad'} moved to place ${ids.indexOf(moved) + 1} of ${ids.length}`);
    },
  });

  const act = useMutation({
    mutationFn: async ({ ad, action }: { ad: StaffAd; action: MenuAction }) => {
      const path = { params: { path: { id: ad.id } } };
      if (action === 'delete') return void (await call(api.DELETE('/api/admin/advertising/ads/{id}', path)));
      if (action === 'pause') return call(api.POST('/api/admin/advertising/ads/{id}/pause', { ...path, body: {} }));
      if (action === 'resume') return call(api.POST('/api/admin/advertising/ads/{id}/resume', { ...path, body: {} }));
      if (action === 'end') return call(api.POST('/api/admin/advertising/ads/{id}/end', { ...path, body: {} }));
      return call(api.POST('/api/admin/advertising/ads/{id}/duplicate', path));
    },
    onSuccess: (r, { ad, action }) => {
      setMenuFor(null);
      setConfirm(null);
      setError('');
      void qc.invalidateQueries({ queryKey: ADS_KEY });
      const msg = `${ad.name} ${DONE[action]}`;
      announce(msg);
      if (action === 'duplicate' && r) navigate(adHref(r.id), { state: { notice: `${msg}. Change what you need, then submit it for review.` } });
      else setNotice(msg);
    },
    onError: (e) => {
      setMenuFor(null);
      setConfirm(null);
      setNotice('');
      setError(errorMessage(e));
    },
  });
  const run = (ad: StaffAd, action: MenuAction) => {
    if (action === 'end' || action === 'delete') {
      setMenuFor(null);
      setConfirm({ ad, action });
    } else act.mutate({ ad, action });
  };
  const menuOf = (ad: StaffAd) => MENU.filter((m) => ad.allowedActions.includes(m.action));

  const waiting = page?.waitingForMeAds ?? [];
  const firstWaiting = waiting[0];
  const addSlot = one ?? (tab === 'departments' ? undefined : slots[0]);
  const tabCount = (t: SlotTab) => slotsOfTab(t).reduce((n, s) => n + (counts[s.key] ?? 0), 0);

  if (!canView) {
    return (
      <AdminLayout active="ads">
        <PageHeader crumbs={[{ label: 'Admin' }, { label: 'Marketing and content' }]} title="Advertisements" />
        <Alert tone="info" title="You don’t have access to Advertisements">
          Seeing ads needs an advertising permission (view, manage or review ads). A Platform Administrator can change your roles in Staff and roles.
        </Alert>
      </AdminLayout>
    );
  }

  const row = (a: StaffAd, draggable: boolean) => {
    const h = sort.handle(a.id);
    const review = a.allowedActions.includes('review');
    const menu = menuOf(a);
    return (
      <tr key={a.id} ref={draggable ? sort.item(a.id) : undefined} style={sort.dragged === a.id ? { opacity: 0.6 } : undefined}>
        <td>
          {draggable && canOrder ? (
            <button type="button" className="icon-btn sm" aria-label={`Move ${a.name}`} title="Drag, or use the arrow keys, to change the carousel order" disabled={order.isPending} {...h} style={{ ...h.style, width: 30, height: 30 }}>
              <Icon name="grip-vertical" className="ic-sm" />
            </button>
          ) : draggable ? (
            <span className="muted" style={{ display: 'inline-flex' }} title={one ? undefined : 'Pick one slot to change its order'}>
              <Icon name="grip-vertical" className="ic-sm" />
            </span>
          ) : null}
        </td>
        <td>
          <span className="row nowrap gap-3" style={{ minWidth: 260 }}>
            <span style={{ width: 120, height: 64, borderRadius: 8, background: 'var(--surface-2)', flex: 'none', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
              {a.image?.url ? <img src={sameOriginFile(a.image.url)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Icon name="image" />}
            </span>
            <span className="stack gap-0" style={{ minWidth: 0 }}>
              <span className="strong">{a.name || 'Untitled ad'}</span>
              <span className="xs muted">
                {[!one && slotOf(a.placementKey)?.dept ? slotOf(a.placementKey)!.dept : !one ? a.placementName : '', actorLabel(a.createdBy), a.stats.views ? `${num(a.stats.views)} views` : ''].filter(Boolean).join(' · ')}
              </span>
            </span>
          </span>
        </td>
        <td>
          {a.destination ? (
            <span className="chip" style={{ paddingRight: 12, maxWidth: 260, boxSizing: 'border-box', overflow: 'hidden', cursor: 'default' }} title={a.destination.available ? a.destination.path : `${a.destination.label}: no longer available`}>
              <span className="xs muted" style={{ fontWeight: 600 }}>
                {kindChip(a.destination)}
              </span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.destination.label}</span>
              {!a.destination.available && <Icon name="triangle-alert" className="ic-sm t-danger-text" />}
            </span>
          ) : (
            <span className="xs muted">Not picked yet</span>
          )}
        </td>
        <td className="nowrap" style={{ color: 'var(--text-2)', fontSize: 12 }}>
          {scheduleText(a)}
        </td>
        <td>
          <AdStatusBadges ad={a} />
          {a.statusNote && <span className="xs muted" style={{ display: 'block', marginTop: 4, maxWidth: 220 }}>{a.statusNote}</span>}
        </td>
        <td className="r nowrap">
          <Button variant="ghost" size="sm" to={review && a.pendingChange?.state === 'in_review' ? adReviewHref(a.id) : adHref(a.id)}>
            {review ? 'Review' : a.allowedActions.includes('edit') ? 'Edit' : 'View'}
            <span className="sr-only"> {a.name}</span>
          </Button>
          {menu.length > 0 ? <IconButton icon="ellipsis" size="sm" label={`More actions for ${a.name}`} aria-haspopup="dialog" onClick={() => setMenuFor(a)} /> : <span style={{ display: 'inline-block', width: 36 }} />}
        </td>
      </tr>
    );
  };

  return (
    <AdminLayout active="ads">
      <PageHeader
        crumbs={[{ label: 'Admin' }, { label: 'Marketing and content' }]}
        title="Advertisements"
        sub="Ads in the app and on the website, by where they show. Each ad goes live after an advertising and a content review by two other staff members."
        actions={
          <>
            {can('advertising.placements.manage') && (
              <Button variant="ghost" size="sm" icon="settings-2" to={href('admin/ad-placements')}>
                Slot settings
              </Button>
            )}
            {canManage && (
              <Button size="sm" icon="plus" to={adHref('new')}>
                Add ad
              </Button>
            )}
          </>
        }
      />
      {notice && <Alert tone="success" title={notice} />}
      {error && <Alert tone="danger" title={error} />}

      {page && page.waitingForMe > 0 && firstWaiting && (
        <div className="alert t-warning" role="status" style={{ alignItems: 'center' }}>
          <Icon name="clock" />
          <span className="grow">
            <strong>
              {page.waitingForMe === 1 ? '1 ad is' : `${page.waitingForMe} ads are`} waiting for your review.
            </strong>{' '}
            {waiting.map((w, i) => (
              <Fragment key={w.id}>
                {i > 0 && (i === waiting.length - 1 ? ' and ' : ', ')}
                <Link to={w.isChange ? adReviewHref(w.id) : adHref(w.id)}>{w.name}</Link>
                {w.isChange ? ' (a change to a live ad)' : ''}
              </Fragment>
            ))}
            .
          </span>
          <Button variant="secondary" size="sm" to={firstWaiting.isChange ? adReviewHref(firstWaiting.id) : adHref(firstWaiting.id)}>
            Review
          </Button>
        </div>
      )}

      <Tabs label="Where ads show" items={TABS.map((t) => ({ value: t.value, label: t.label, count: page ? tabCount(t.value) : undefined }))} active={tab} onChange={goTab} />

      <section className="card">
        <div className="card-head">
          <div className="row nowrap gap-3" style={{ gap: 14, minWidth: 0 }}>
            <span className="imgph" style={{ width: 44, height: 44, borderRadius: 10, background: 'var(--brand-soft)', color: 'var(--brand-text)', aspectRatio: 'auto' }}>
              <Icon name={one?.icon ?? slots[0]!.icon} />
            </span>
            <span className="stack gap-0" style={{ minWidth: 0, gap: 2 }}>
              <h2 className="h4">
                {one ? one.name : tab === 'departments' ? 'Department carousels' : 'Category banner and pop-up'}
                {one && page?.slots[one.key] && !page.slots[one.key]!.enabled && (
                  <>
                    {' '}
                    <Badge tone="warning">Off in Slot settings</Badge>
                  </>
                )}
              </h2>
              <span className="xs muted">
                {one
                  ? `${one.where} · phone image ${sizeText(one.phone)}${one.web ? ` (+ website ${sizeText(one.web)}, optional)` : ''} · ${slotNote(page?.slots[one.key]) || one.rotation}`
                  : tab === 'departments'
                    ? `Top of the Softwares, Food delivery, Companies and Play center pages · phone image 750 × 400 · each department has its own carousel${slotNote(page?.slots.food_top) ? ` · ${slotNote(page?.slots.food_top)}` : ''}`
                    : 'Category banner: top of category pages, 750 × 300 · Pop-up: over Home, search and product pages, 600 × 600'}
              </span>
            </span>
          </div>
          {canManage && (
            <Button variant="soft" size="sm" icon="plus" to={adHref('new', { slot: addSlot ? addSlot.key : 'department' })}>
              {addSlot ? addSlot.add : 'Add department ad'}
            </Button>
          )}
        </div>
        {slots.length > 1 && (
          <div className="row gap-2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }} role="group" aria-label={tab === 'departments' ? 'Department' : 'Slot'}>
            <Chip active={!one} onClick={() => goSlot('')}>
              {tab === 'departments' ? 'All departments' : 'Both'}
            </Chip>
            {slots.map((s) => (
              <Chip key={s.key} active={one?.key === s.key} onClick={() => goSlot(s.key)}>
                {s.dept ?? s.name} {page && counts[s.key] ? <span className="muted">{counts[s.key]}</span> : null}
              </Chip>
            ))}
          </div>
        )}
        <div className="row gap-2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }} role="group" aria-label="Status">
          {STATUS_FILTERS.map((f) => {
            const n = statusCount(f);
            if (f.value === 'paused' && !n) return null;
            return (
              <Chip key={f.value} active={status === f.value} onClick={() => setStatus(f.value)}>
                {f.label}
                {page && n ? ` ${n}` : ''}
              </Chip>
            );
          })}
        </div>
        {list.isError ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : list.isPending ? (
          <div className="card-body">
            <SkeletonLines rows={6} />
          </div>
        ) : shownItems.length === 0 ? (
          <div className="card-body">
            <EmptyState icon="megaphone" title={status === 'all' ? 'No ads here yet' : 'No ads with this status'} as="h2" action={canManage && status === 'all' && <Button size="sm" icon="plus" to={adHref('new', { slot: addSlot ? addSlot.key : 'department' })}>{addSlot ? addSlot.add : 'Add department ad'}</Button>}>
              {status === 'all' ? 'Add an ad: pick the image and what it opens, then submit it for review.' : 'Pick another status above.'}
            </EmptyState>
          </div>
        ) : (
          <TableWrap label="Ads table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 24 }}>
                    <span className="sr-only">Order</span>
                  </th>
                  <th scope="col">Ad</th>
                  <th scope="col">Opens</th>
                  <th scope="col">Schedule</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sort.order.map((id) => byId.get(id)).filter((a): a is StaffAd => !!a).map((a) => row(a, true))}
                {rest.map((a) => row(a, false))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <div className="card-foot" style={{ justifyContent: 'space-between' }}>
          <span className="xs muted">{canOrder ? 'Drag live and scheduled ads to change their order in the carousel · ⋮ has Pause, End now, Duplicate and Delete draft' : one ? '⋮ has Pause, End now, Duplicate and Delete draft' : 'Pick one department or slot above to change the order of its live and scheduled ads'}</span>
        </div>
      </section>

      <Dialog open={!!menuFor} onClose={() => setMenuFor(null)} title={menuFor ? `Actions for ${menuFor.name}` : 'Actions'} size="sm">
        {menuFor && (
          <div className="menu-list">
            {menuOf(menuFor).map((m) => (
              <button key={m.action} type="button" onClick={() => run(menuFor, m.action)} disabled={act.isPending}>
                <Icon name={m.icon} />
                {m.label}
              </button>
            ))}
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm ? (confirm.action === 'end' ? `End ${confirm.ad.name} now?` : `Delete ${confirm.ad.name}?`) : ''}
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {confirm?.action === 'end' ? 'Keep it running' : 'Keep it'}
            </Button>
            <Button variant="danger" onClick={() => confirm && act.mutate(confirm)} disabled={act.isPending}>
              {act.isPending ? 'Working…' : confirm?.action === 'end' ? 'End now' : 'Delete draft'}
            </Button>
          </>
        }
      >
        <p className="small" style={{ margin: 0 }}>
          {confirm?.action === 'end'
            ? `The ad leaves the app within a minute and can’t be started again (duplicate it to run it later).${confirm.ad.pendingChange ? ' Its edit waiting for review is dropped too.' : ''}`
            : 'The draft is deleted for good.'}
        </p>
      </Dialog>
    </AdminLayout>
  );
}
