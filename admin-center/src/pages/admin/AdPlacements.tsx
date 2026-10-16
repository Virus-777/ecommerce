import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, Field, Icon, KeyValue, Switch, TextInput, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, LoadError, SkeletonLines } from '@/app/parts';
import { AVAILABILITY, pageLabel, placementIcon, type GlobalRules, type Placement, type PlacementPatch } from './data/ads';

// Design: pages/admin/admin-ad-placements.html. Data: GET /api/admin/advertising/placements (cards),
// GET …/rules (global rules), PATCH …/placements/{id} (on/off and rules, with the version read and a reason).

interface Draft {
  pages: string;
  perSession: string;
  perDay: string;
  maxPerPage: string;
  dismissDays: string;
  reason: string;
}

const RULE_LABELS = ['Pages', 'Formats', 'Frequency cap', 'When several ads qualify', 'Dismissal'] as const;

function rulePairs(p: Placement): Array<[string, string]> {
  const cap = p.frequencyCap?.label ?? (p.kind === 'overlay' || p.kind === 'strip' ? '—' : 'No cap (in-page)');
  const extra = [p.maxPerPage && p.kind === 'card' ? `max ${p.maxPerPage} per results page` : '', p.positions?.length ? `positions ${p.positions.join(' and ')}` : '', p.trigger ? [p.trigger.afterSeconds ? `after ${p.trigger.afterSeconds} s` : '', p.trigger.scrollPct ? `${p.trigger.scrollPct}% scroll` : ''].filter(Boolean).join(' or ') : '']
    .filter(Boolean)
    .join(' · ');
  return [
    [RULE_LABELS[0], p.pagesLabel],
    [RULE_LABELS[1], p.formats.map((f) => f.label).join(' · ') || '—'],
    [RULE_LABELS[2], [cap === '—' && extra ? '' : cap, extra].filter(Boolean).join(' · ')],
    [RULE_LABELS[3], p.rotation.label],
    [RULE_LABELS[4], p.dismissal.label],
  ];
}

const footNote = (p: Placement) => (p.enabled ? `${p.liveCampaigns} live campaign${p.liveCampaigns === 1 ? '' : 's'}` : p.availability === 'later' ? 'Turn on when approval and billing are ready' : 'Off: no new displays');

function globalRules(r: GlobalRules): Array<{ icon: IconName; t: string; d: string; locked?: boolean }> {
  return [
    { icon: 'shield-check', t: 'Never cover checkout, payment results, tracking or returns', d: `Overlays and interstitials are blocked on ${r.blockedPages.map((p) => pageLabel(p).toLowerCase()).join(', ')}` },
    { icon: 'layers', t: r.overlaysPerPageView === 1 ? 'One overlay at a time' : `${r.overlaysPerPageView} overlays per page view`, d: 'Opening ad, pop-up and interstitial never stack' },
    { icon: 'tag', t: 'Ad label required', d: '"Ad" on overlays and banners, "Sponsored" on product and store cards. Locked on for every placement and campaign.', locked: true },
    { icon: 'x', t: 'Visible close control', d: `At least ${r.closeControlMinPx} px on phones, reachable with the keyboard, returns to the intended page` },
    ...(r.removeUnavailable ? [{ icon: 'package-x' as IconName, t: 'Remove unavailable or expired ads', d: 'Ads stop when the promoted offer sells out or the campaign ends' }] : []),
    ...(r.sellerNamedOnPromotedOffers ? [{ icon: 'user-round' as IconName, t: 'Seller behind promoted offers is named', d: 'Seller ad content is reviewed before it runs' }] : []),
  ];
}

const intOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

export default function AdPlacements() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canManage = can('advertising.placements.manage');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [notice, setNotice] = useState('');

  const list = useQuery({ queryKey: ['advertising', 'placements'], queryFn: () => call(api.GET('/api/admin/advertising/placements')) as Promise<Placement[]> });
  const rules = useQuery({ queryKey: ['advertising', 'rules'], queryFn: () => call(api.GET('/api/admin/advertising/rules')) as Promise<GlobalRules> });

  const patch = useMutation({
    mutationFn: ({ p, body }: { p: Placement; body: Omit<PlacementPatch, 'version'>; msg: string }) =>
      call(api.PATCH('/api/admin/advertising/placements/{id}', { params: { path: { id: p.id } }, body: { ...body, version: p.version } as PlacementPatch })) as Promise<Placement>,
    onSuccess: (updated, { msg }) => {
      qc.setQueryData<Placement[]>(['advertising', 'placements'], (l) => l?.map((x) => (x.id === updated.id ? updated : x)));
      setEditing(null);
      setNotice(msg);
      announce(msg);
    },
    onError: (e) => {
      // CONFLICT: someone changed it meanwhile; reload so the next try sends the current version.
      if ((e as { code?: string }).code === 'CONFLICT') void list.refetch();
    },
  });

  const toggle = (p: Placement, on: boolean) => {
    patch.reset();
    patch.mutate({ p, body: { enabled: on, reason: on ? 'Turned on from Placements and rules' : 'Turned off from Placements and rules' }, msg: `${p.name} ${on ? 'enabled' : 'turned off'}. The change applies to new displays now and is recorded in Action history.` });
  };
  const startEdit = (p: Placement) => {
    patch.reset();
    setErrors({});
    setEditing(p.id);
    setDraft({
      pages: p.eligiblePages.join(', '),
      perSession: p.frequencyCap?.perSession != null ? String(p.frequencyCap.perSession) : '',
      perDay: p.frequencyCap?.perDay != null ? String(p.frequencyCap.perDay) : '',
      maxPerPage: p.maxPerPage != null ? String(p.maxPerPage) : '',
      dismissDays: p.dismissal.mode === 'days' && p.dismissal.days ? String(p.dismissal.days) : '',
      reason: '',
    });
  };
  const save = (p: Placement) => {
    if (!draft) return;
    const e: typeof errors = {};
    const pages = draft.pages.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!pages.length) e.pages = 'Choose at least one page type, e.g. home, category.';
    for (const k of ['perSession', 'perDay', 'maxPerPage', 'dismissDays'] as const) if (draft[k].trim() && !/^\d+$/.test(draft[k].trim())) e[k] = 'Enter a whole number, or leave it empty.';
    if (!draft.reason.trim()) e.reason = 'Enter a reason. It is recorded in Action history.';
    setErrors(e);
    if (Object.keys(e).length) return;
    const capChanged = p.frequencyCap || draft.perSession || draft.perDay;
    const body: Omit<PlacementPatch, 'version'> = {
      eligiblePages: pages,
      maxPerPage: intOrNull(draft.maxPerPage),
      reason: draft.reason.trim(),
      // Inputs only: the cap and dismissal labels are made by the server (FrequencyCapInput, DismissalRuleInput).
      ...(capChanged ? { frequencyCap: { perWindow: p.frequencyCap?.perWindow ?? null, perCampaign: p.frequencyCap?.perCampaign ?? null, perSession: intOrNull(draft.perSession), perDay: intOrNull(draft.perDay) } } : {}),
      ...(p.dismissal.mode === 'days' || draft.dismissDays ? { dismissal: draft.dismissDays ? { mode: 'days', days: Number(draft.dismissDays) } : { mode: p.dismissal.mode, days: p.dismissal.days ?? null } } : {}),
    } satisfies Omit<PlacementPatch, 'version'>;
    patch.mutate({ p, body, msg: `${p.name} rules saved. The change applies to new displays now and is recorded in Action history.` });
  };

  const all = list.data ?? [];
  const cards = all.filter((p) => p.key !== 'video');
  const video = all.find((p) => p.key === 'video');
  const set = (k: keyof Draft, v: string) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
    setErrors((x) => ({ ...x, [k]: undefined }));
  };

  return (
    <AdminLayout active="ads">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Advertisements', to: href('admin/ads') }, { label: 'Placements and rules' }]} />
          <h1 className="h1">Placements and rules</h1>
          <p className="sub small">Owned by Advertising · changes take effect for new displays immediately and are recorded in Action history</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="history" to={href('admin/audit')}>
            Action history
          </Button>
        </div>
      </div>

      {notice && <Alert tone="success" title={notice} />}
      {patch.error && !editing && (
        <Alert tone="danger" title="The change wasn’t saved">
          {errorMessage(patch.error)}
        </Alert>
      )}
      {!canManage && <Alert tone="info" title="View only">Changing placements needs the placement management permission (Advertising Manager).</Alert>}

      <Card title="Global rules" sub="Apply to every placement and campaign. The Ad label rule is always on and cannot be turned off; changing the others needs Business Owner approval.">
        {rules.error ? (
          <LoadError error={rules.error} onRetry={() => void rules.refetch()} />
        ) : !rules.data ? (
          <SkeletonLines rows={4} />
        ) : (
          <>
            <ul className="ab-rules">
              {globalRules(rules.data).map((r) => (
                <li key={r.t}>
                  <Icon name={r.icon} />
                  <span className={cx('stack gap-0', r.locked && 'grow')}>
                    <span className="small strong">{r.t}</span>
                    <span className="xs muted">{r.d}</span>
                  </span>
                  {r.locked && (
                    <>
                      <label className="switch" htmlFor="pl-rule-label" title="Always on">
                        <input type="checkbox" role="switch" id="pl-rule-label" checked disabled aria-readonly="true" readOnly />
                        <span className="sr-only">Ad label required (always on)</span>
                      </label>
                      <Badge icon="lock">Always on</Badge>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <p className="xs muted">
              Version {rules.data.version}, effective {date(rules.data.effectiveAt)} · attribution {rules.data.attributionDays} days after a click · paid seller ads {rules.data.paidSellerAdsEnabled ? 'on' : 'off'}
              {rules.data.approval?.required ? ' · a change is waiting for Business Owner approval' : ''}
            </p>
          </>
        )}
      </Card>

      {list.error && <LoadError error={list.error} onRetry={() => void list.refetch()} />}

      <div className="ab-place">
        {!list.data &&
          !list.error &&
          Array.from({ length: 4 }, (_, i) => (
            <section key={i} className="card">
              <div className="card-body">
                <SkeletonLines rows={4} />
              </div>
            </section>
          ))}
        {cards.map((p) => {
          const isEditing = editing === p.id && draft;
          const stage = AVAILABILITY[p.availability];
          return (
            <section key={p.id} className={cx('card', !p.enabled && 'is-off')}>
              <div className="card-head">
                <span className="row gap-2">
                  <Icon name={placementIcon(p.key)} />
                  <h3 className="h4">{p.name}</h3>
                  <Badge tone={stage.tone}>{stage.label}</Badge>
                </span>
                <Switch id={`pl-on-${p.id}`} label={p.enabled ? 'Enabled' : 'Off'} checked={p.enabled} disabled={!canManage || patch.isPending} onChange={(e) => toggle(p, e.target.checked)} />
              </div>
              <div className="card-body">
                {isEditing ? (
                  <div className="stack gap-3">
                    <Field label="Pages" hint="Page types, comma-separated (home, category, search, product, campaign, collection, deals)" error={errors.pages}>
                      <TextInput id={`pl-${p.id}-pages`} value={draft.pages} error={!!errors.pages} onChange={(e) => set('pages', e.target.value)} />
                    </Field>
                    <Field label="Formats" hint="Set by the placement">
                      <TextInput id={`pl-${p.id}-formats`} value={p.formats.map((f) => f.label).join(' · ')} disabled />
                    </Field>
                    <Field label="Frequency cap: per session" hint="Empty = no cap" error={errors.perSession}>
                      <TextInput id={`pl-${p.id}-cap`} inputMode="numeric" value={draft.perSession} error={!!errors.perSession} onChange={(e) => set('perSession', e.target.value)} />
                    </Field>
                    <Field label="Frequency cap: per day" hint="Empty = no cap" error={errors.perDay}>
                      <TextInput id={`pl-${p.id}-capday`} inputMode="numeric" value={draft.perDay} error={!!errors.perDay} onChange={(e) => set('perDay', e.target.value)} />
                    </Field>
                    <Field label="Most ads per page" error={errors.maxPerPage}>
                      <TextInput id={`pl-${p.id}-priority`} inputMode="numeric" value={draft.maxPerPage} error={!!errors.maxPerPage} onChange={(e) => set('maxPerPage', e.target.value)} />
                    </Field>
                    <Field label="Dismissal: hide for days" hint={p.dismissal.label} error={errors.dismissDays}>
                      <TextInput id={`pl-${p.id}-dismissal`} inputMode="numeric" value={draft.dismissDays} error={!!errors.dismissDays} onChange={(e) => set('dismissDays', e.target.value)} />
                    </Field>
                    <Field label="Reason" error={errors.reason ?? (patch.error ? errorMessage(patch.error) : undefined)}>
                      <TextInput id={`pl-${p.id}-reason`} value={draft.reason} error={!!errors.reason} onChange={(e) => set('reason', e.target.value)} />
                    </Field>
                  </div>
                ) : (
                  <KeyValue pairs={rulePairs(p)} />
                )}
              </div>
              <div className="card-foot">
                {isEditing ? (
                  <>
                    <span className="xs muted grow">Applies to new displays immediately</span>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => save(p)} disabled={patch.isPending}>
                      Save rules
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="xs muted grow">{footNote(p)}</span>
                    {canManage && (
                      <Button variant="ghost" size="sm" icon="pencil" onClick={() => startEdit(p)}>
                        Edit rules
                      </Button>
                    )}
                  </>
                )}
              </div>
            </section>
          );
        })}
        {list.data && (
          <section className={cx('card', !video?.enabled && 'is-off')}>
            <div className="card-head">
              <span className="row gap-2">
                <Icon name="video" />
                <h3 className="h4">{video?.name ?? 'Video'}</h3>
                <Badge>Later</Badge>
              </span>
              <Switch id="pl-on-video" label={video?.enabled ? 'Enabled' : 'Not available'} checked={!!video?.enabled} disabled />
            </div>
            <div className="card-body">
              <p className="small sub">Playback and mute controls, designated campaign and display areas. Planned after launch.</p>
            </div>
          </section>
        )}
      </div>
    </AdminLayout>
  );
}
