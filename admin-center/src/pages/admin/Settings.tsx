import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Card, Dialog, Field, Icon, PageHeader, Select, Switch, Textarea, TextInput, iconFor } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, date, screenHref } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import {
  dayFromToday, fromField, isJsonish, OWNER_SCREEN, sameValue, SCOPE_OPTIONS, sectionIcon, toField,
  type ApplyScope, type SettingChange, type SettingDefinition, type SettingsOverview, type SettingsSection,
} from './data/settings';
import { ProductImageSettingsCard } from './data/product-image-settings';
import { effectiveInstant } from './data/staff';

/** Section-list index of the Products section (not one of the API's sections). */
const PRODUCTS = -1;

// Design: pages/admin/admin-settings.html · view "review-change" = review dialog for a drafted change.
// Editing a field never applies it: "Review change" drafts the change on the API (impact preview), the dialog shows
// old → new, effective date, scope, impact and reason, and only confirming submits it: scheduled, or sent for approval.
// The overview carries each value's raw `value` and `valueType`, so editing needs no extra reads. The reason is
// optional while drafting and previewing, and required at submit (POST /changes/{id}/submit { reason }).

function Note({ children }: { children: ReactNode }) {
  return (
    <span className="xs muted row gap-1 nowrap wrap">
      <Icon name="info" className="ic-sm" />
      <span>{children}</span>
    </span>
  );
}

type Draft = Record<string, string | boolean>;

export default function Settings() {
  const [view, setView] = useView<'review-change'>();
  const { api } = useApi();
  const qc = useQueryClient();
  const me = useStaffSession();
  const canView = me.can('settings.view');
  const canPropose = me.can('settings.changes.propose');

  const overviewQ = useQuery({
    queryKey: ['settings', 'overview'],
    queryFn: () => call(api.GET('/api/admin/settings/overview')) as Promise<SettingsOverview>,
    enabled: canView,
    // A scheduled change takes effect on the server (job settings.apply-due-changes, every minute) without the page
    // asking: while one is due within 2 minutes or overdue, check every 10 s so the new values show without a reload.
    refetchInterval: (q) => {
      const soon = Date.now() + 2 * 60_000;
      return (q.state.data?.scheduled ?? []).some((c) => c.status === 'scheduled' && new Date(c.effectiveAt).getTime() <= soon) ? 10_000 : false;
    },
  });
  const defsQ = useQuery({ queryKey: ['settings', 'definitions'], queryFn: () => call(api.GET('/api/admin/settings/definitions')) as Promise<SettingDefinition[]>, enabled: canView, staleTime: 5 * 60_000 });
  const defs = useMemo(() => new Map((defsQ.data ?? []).map((d) => [d.key, d])), [defsQ.data]);
  const sections = useMemo(() => (overviewQ.data?.sections ?? []).filter((s) => s.available), [overviewQ.data]);
  const currency = overviewQ.data?.market.currency ?? 'USD';

  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft>({});
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ title: string; text: string } | null>(null);

  // Raw values in force, from the overview (settings-owned values carry `value`).
  const current = useMemo(() => new Map<string, unknown>(sections.filter((s) => s.ownedHere).flatMap((s) => s.values.filter((v) => !!v.key).map((v) => [v.key!, v.value ?? null] as const))), [sections]);

  const fieldValue = (key: string): string | boolean | undefined => {
    if (key in draft) return draft[key];
    const def = defs.get(key);
    return def && current.has(key) ? toField(def, current.get(key)) : undefined;
  };
  const isDirty = (key: string) => {
    const def = defs.get(key);
    if (!def || !(key in draft) || !current.has(key)) return false;
    try {
      return !sameValue(fromField(def, draft[key], currency), current.get(key));
    } catch {
      return true;
    }
  };
  const sectionKeys = (s: SettingsSection) => s.values.map((v) => v.key).filter((k): k is string => !!k);
  const dirtyKeys = (s: SettingsSection) => sectionKeys(s).filter(isDirty);
  const set = (key: string, v: string | boolean) => {
    setDraft((d) => ({ ...d, [key]: v }));
    setFieldErr((e) => ({ ...e, [key]: '' }));
  };

  // Keep the selected section visible inside the scrolling section list (only the list moves, not the page).
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>('.ac-setnav');
    const a = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !a || nav.scrollHeight <= nav.clientHeight) return;
    // The sticky list is the items' offset parent, so offsetTop is already measured from it.
    const top = a.offsetParent === nav ? a.offsetTop : a.offsetTop - nav.offsetTop;
    if (top < nav.scrollTop) nav.scrollTop = top - 8;
    else if (top + a.offsetHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = top + a.offsetHeight - nav.clientHeight + 8;
  }, [active]);
  // Scroll spy: the list follows the card being read. The active card is the last one whose top has passed a
  // line a quarter of the way down the screen; at the end of the page the last card wins (it may never reach it).
  // A click in the list keeps its choice until that smooth scroll ends.
  const spyPaused = useRef(0);
  const loaded = sections.length > 0 && !defsQ.isPending;
  useEffect(() => {
    if (!loaded) return;
    // measured on each scroll event (about 20 cards); requestAnimationFrame would stall in a background tab
    const spy = (e?: Event) => {
      if (Date.now() < spyPaused.current) return;
      const cards = Array.from(document.querySelectorAll<HTMLElement>('.ac-set [id^="set-"]'));
      if (!cards.length) return;
      // the switch line: a quarter of the way down the area below the sticky header
      const navTop = Math.max(document.querySelector('.ac-setnav')?.getBoundingClientRect().top ?? 0, 0);
      const line = navTop + (window.innerHeight - navTop) / 4;
      const target = e?.target;
      // only the scrolling that moves the cards (not the section list's own scrolling, nor other panels)
      if (target instanceof HTMLElement && !target.contains(cards[0]!)) return;
      const scroller = target instanceof HTMLElement ? target : document.scrollingElement;
      const atEnd = !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2 && scroller.scrollTop > 0;
      let current = cards[0]!;
      if (atEnd) current = cards[cards.length - 1]!;
      else for (const c of cards) if (c.getBoundingClientRect().top <= line) current = c;
      const i = current.id === 'set-products' ? PRODUCTS : Number(current.id.slice(4));
      if (!Number.isNaN(i)) setActive(i);
    };
    const ended = () => {
      if (spyPaused.current) spyPaused.current = 0;
    };
    // capture: the scrolling element may be the page or a layout container
    document.addEventListener('scroll', spy, { capture: true, passive: true });
    document.addEventListener('scrollend', ended, { capture: true });
    spy();
    return () => {
      document.removeEventListener('scroll', spy, { capture: true });
      document.removeEventListener('scrollend', ended, { capture: true });
    };
  }, [loaded]);
  const goTo = (i: number) => {
    setActive(i);
    spyPaused.current = Date.now() + 1500;
    document.getElementById(i === PRODUCTS ? 'set-products' : `set-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // The Products section (product image crop and sizes) is the web app's own card; it follows Catalog in the list.
  const productsAt = (() => {
    const c = sections.findIndex((s) => s.key === 'catalog');
    return c >= 0 ? c + 1 : sections.length;
  })();
  const startEdit = (i: number) => {
    setActive(i);
    setEditing((e) => (e.includes(sections[i].key) ? e : [...e, sections[i].key]));
  };
  const discard = (i: number) => {
    const keys = sectionKeys(sections[i]);
    setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !keys.includes(k))));
    setFieldErr({});
    setEditing((e) => e.filter((x) => x !== sections[i].key));
  };

  /* ---------- review dialog: draft on the API, then submit ---------- */

  const [change, setChange] = useState<SettingChange | null>(null);
  const [changeSection, setChangeSection] = useState<number>(0);
  const [effective, setEffective] = useState('');
  const [scope, setScope] = useState<ApplyScope>('new_only');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ reason?: string; effective?: string }>({});
  const [reviewErr, setReviewErr] = useState<Record<number, string>>({});

  const itemsOf = (s: SettingsSection) =>
    dirtyKeys(s).map((key) => {
      const def = defs.get(key)!;
      return { key, value: fromField(def, draft[key], currency) };
    });

  const draftM = useMutation({
    mutationFn: (v: { i: number; items: Array<{ key: string; value: unknown }>; effective: string }) =>
      call(api.POST('/api/admin/settings/changes', { body: { items: v.items, effectiveAt: effectiveInstant(v.effective), applyScope: 'new_only' } })) as Promise<SettingChange>,
    onSuccess: (c, v) => {
      setChange(c);
      setChangeSection(v.i);
      setReviewErr((e) => ({ ...e, [v.i]: '' }));
      setView('review-change');
    },
    onError: (e, v) => setReviewErr((r) => ({ ...r, [v.i]: errorMessage(e) })),
  });
  const patchM = useMutation({
    mutationFn: (v: { effective: string; scope: ApplyScope; reason: string }) =>
      call(
        api.PATCH('/api/admin/settings/changes/{id}', {
          params: { path: { id: change!.id } },
          body: { items: change!.items.map((it) => ({ key: it.key, value: it.to })), effectiveAt: effectiveInstant(v.effective), applyScope: v.scope, ...(v.reason ? { reason: v.reason } : {}) },
        }),
      ) as Promise<SettingChange>,
    onSuccess: (c) => setChange(c),
  });
  const submitM = useMutation({
    mutationFn: async () => {
      const c = (await call(
        api.PATCH('/api/admin/settings/changes/{id}', {
          params: { path: { id: change!.id } },
          body: { items: change!.items.map((it) => ({ key: it.key, value: it.to })), effectiveAt: effectiveInstant(effective), applyScope: scope, reason: reason.trim() },
        }),
      )) as SettingChange;
      if (c.impact.blocking.length) return c;
      return (await call(api.POST('/api/admin/settings/changes/{id}/submit', { params: { path: { id: c.id } }, body: { reason: reason.trim() } }))) as SettingChange;
    },
    onSuccess: (c) => {
      if (c.status === 'draft') {
        setChange(c);
        return;
      }
      const s = sections[changeSection];
      const what = c.items.map((it) => `${it.label}: ${it.fromText} → ${it.toText}`).join('; ');
      if (c.status === 'pending_approval') {
        const who = c.impact.approvers.join(' or ') || (c.impact.approvalRule === 'business_owner' ? 'the Business Owner' : 'a second reviewer');
        setNotice({ title: `${s?.title ?? 'Settings'} change sent for approval`, text: `${what}. ${who} approves it before it is scheduled for ${date(c.effectiveAt)}. The current setting stays in place until then.` });
        announce(`${s?.title ?? 'Settings'} change sent for approval`);
      } else {
        setNotice({ title: `${s?.title ?? 'Settings'} change saved`, text: `${what}. Effective ${date(c.effectiveAt)}. ${SCOPE_OPTIONS.find((o) => o.value === c.applyScope)?.label ?? ''}.` });
        announce(`${s?.title ?? 'Settings'} change saved`);
      }
      if (s) discard(changeSection);
      setChange(null);
      setView('');
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    },
  });

  const review = (i: number) => {
    const s = sections[i];
    const errs: Record<string, string> = {};
    for (const key of dirtyKeys(s)) {
      try {
        fromField(defs.get(key)!, draft[key], currency);
      } catch (e) {
        errs[key] = (e as Error).message;
      }
    }
    setFieldErr(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`se-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    const lead = Math.max(0, ...dirtyKeys(s).map((k) => defs.get(k)?.minLeadDays ?? 0));
    const eff = dayFromToday(lead);
    setEffective(eff);
    setScope('new_only');
    setReason('');
    setErrors({});
    setActive(i);
    draftM.mutate({ i, items: itemsOf(s), effective: eff });
  };

  const closeReview = () => {
    // A draft that is not saved is withdrawn so it doesn't linger in the change list.
    if (change && change.status === 'draft') void call(api.POST('/api/admin/settings/changes/{id}/cancel', { params: { path: { id: change.id } }, body: { reason: 'Closed without saving' } })).catch(() => undefined);
    setChange(null);
    setView('');
  };
  const confirm = () => {
    const e = { reason: reason.trim() ? undefined : 'Enter a reason for this change. It is saved in Action history.', effective: effective ? undefined : 'Enter the date the change starts.' };
    if (e.reason || e.effective) {
      setErrors(e);
      document.getElementById(e.effective ? 'se-m-eff' : 'se-m-reason')?.focus();
      return;
    }
    submitM.mutate();
  };
  const changeEffective = (v: string) => {
    setEffective(v);
    setErrors((x) => ({ ...x, effective: undefined }));
    if (v) patchM.mutate({ effective: v, scope, reason: reason.trim() });
  };
  const changeScope = (v: ApplyScope) => {
    setScope(v);
    patchM.mutate({ effective, scope: v, reason: reason.trim() });
  };

  /* ---------- field and section rendering ---------- */

  const field = (v: SettingsSection['values'][number], isEditing: boolean) => {
    const key = v.key ?? '';
    const def = key ? defs.get(key) : undefined;
    const id = `se-${key || v.label}`;
    const hint = [v.hint ?? def?.description, v.exampleValue ? 'Example value to confirm.' : ''].filter(Boolean).join(' ');
    const val = isEditing && def ? fieldValue(key) : undefined;
    const editable = isEditing && !!def && def.editable && val !== undefined && me.can(def.editPermission || 'settings.changes.propose');
    if (def?.valueType === 'bool') {
      const on = val !== undefined ? Boolean(val) : v.valueText === 'On';
      return <Switch key={id} id={id} label={v.label} checked={on} aria-checked={on} data-switch="" disabled={!editable} onChange={(e) => set(key, e.target.checked)} />;
    }
    let control: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
    if (!editable) {
      control = <TextInput id={id} value={v.valueText} readOnly aria-readonly="true" />;
    } else if (def.valueType === 'enum') {
      control = <Select id={id} options={def.enumValues} value={String(val)} onChange={(e) => set(key, e.target.value)} />;
    } else if (isJsonish(def)) {
      control = <Textarea id={id} value={String(val)} onChange={(e) => set(key, e.target.value)} />;
    } else {
      control = (
        <TextInput
          id={id}
          type={def.valueType === 'time' ? 'time' : 'text'}
          prefix={def.valueType === 'money' ? '$' : undefined}
          suffix={def.unit ?? undefined}
          value={String(val)}
          onChange={(e) => set(key, e.target.value)}
        />
      );
    }
    const wide = def ? isJsonish(def) || def.valueType === 'text' : v.valueText.length > 60;
    return (
      <div className={wide ? 'full' : undefined} key={id}>
        <Field label={v.label} hint={hint || undefined} error={fieldErr[key]}>
          {control}
        </Field>
      </div>
    );
  };

  const sectionCard = (s: SettingsSection, i: number) => {
    const dirty = dirtyKeys(s).length > 0;
    const isEditing = editing.includes(s.key);
    const open = dirty || isEditing;
    const pendingApproval = s.scheduled.some((c) => c.status === 'pending_approval');
    const scheduled = s.scheduled.some((c) => c.status === 'scheduled');
    const link = screenHref(s.link?.screen ?? OWNER_SCREEN[s.key]);
    const bools = s.values.filter((v) => v.key && defs.get(v.key)?.valueType === 'bool');
    const others = s.values.filter((v) => !bools.includes(v));
    const canEdit = canPropose && s.ownedHere && s.values.some((v) => v.key && defs.get(v.key)?.editable);
    return (
      <Card
        key={s.key}
        className="ac-sect"
        id={`set-${i}`}
        title={s.title}
        titleClassName="h3"
        sub={s.subtitle ?? undefined}
        actions={
          <>
            {pendingApproval && (
              <Badge tone="warning" icon="hourglass">
                Approval pending
              </Badge>
            )}
            {scheduled && (
              <Badge tone="warning" icon="calendar-clock">
                Change scheduled
              </Badge>
            )}
            {canEdit ? (
              <Button variant="secondary" size="sm" icon="pencil" onClick={() => startEdit(i)}>
                Edit
              </Button>
            ) : !s.ownedHere && link ? (
              <Button variant="secondary" size="sm" icon="external-link" to={link}>
                Open
              </Button>
            ) : null}
          </>
        }
        footClassName="between"
        foot={
          <>
            <div className="ac-meta">
              <span>
                <Icon name="history" className="ic-sm" />
                {s.lastChange
                  ? `Last changed ${date(s.lastChange.at)} by ${s.lastChange.by.name ?? 'staff'}${s.lastChange.approvedBy?.name ? `, approved by ${s.lastChange.approvedBy.name}` : ''}`
                  : 'Not changed since launch'}
              </span>
              {s.lastChange && (
                <span>
                  <Icon name="calendar-check" className="ic-sm" />
                  Effective {date(s.lastChange.effectiveFrom)}
                </span>
              )}
            </div>
            {open && (
              <div className="row gap-2">
                <Button variant="ghost" size="sm" onClick={() => discard(i)}>
                  Discard
                </Button>
                <Button size="sm" icon="eye" disabled={!dirty || draftM.isPending} onClick={() => review(i)}>
                  Review change
                </Button>
              </div>
            )}
          </>
        }
      >
        {reviewErr[i] && (
          <Alert tone="danger" title="The change couldn’t be drafted">
            {reviewErr[i]}
          </Alert>
        )}
        {others.length > 0 && <div className="ac-fgrid">{others.map((v) => field(v, isEditing))}</div>}
        {/* on/off settings side by side, wrapping to the next line when they don't fit */}
        {bools.length > 0 && <div className="row gap-6">{bools.map((v) => field(v, isEditing))}</div>}
        {!s.values.length && <Note>No values yet.</Note>}
        {s.scheduled.map((c) => (
          <Note key={c.ref}>
            {c.title} · {date(c.effectiveAt)} · {c.appliesTo}
            {c.status === 'pending_approval' ? ' · waiting for approval' : c.approvedBy?.name ? ` · approved by ${c.approvedBy.name}` : ''}
          </Note>
        ))}
        {s.values.some((v) => v.exampleValue) && <Note>Example values are business examples still to be confirmed.</Note>}
      </Card>
    );
  };

  const scheduledAll = overviewQ.data?.scheduled ?? [];
  const shownSection = sections[changeSection];

  const productsLink = (
    <a
      href="#"
      className={cx(active === PRODUCTS && 'is-active')}
      aria-current={active === PRODUCTS ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        goTo(PRODUCTS);
      }}
    >
      <Icon name="package" className="ic-sm" />
      Products
    </a>
  );

  if (!canView) {
    return (
      <AdminLayout active="settings">
        <PageHeader crumbs={[{ label: 'Reports and settings' }, { label: 'Settings' }]} title="Settings" />
        <Alert tone="info" title="You don’t have access to settings">
          Viewing settings needs the “View settings” permission. Ask a Platform Administrator.
        </Alert>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout active="settings">
      <PageHeader
        crumbs={[{ label: 'Reports and settings' }, { label: 'Settings' }]}
        title="Settings"
        sub={`Market rules for the ${overviewQ.data?.market.serviceRegion.label ?? 'United States'} marketplace. Every change states its effective date and its effect on existing orders before you save.`}
        actions={
          <Button variant="secondary" size="sm" icon="history" to={href('admin/audit', '', undefined, { category: 'settings' })}>
            View change history
          </Button>
        }
      />
      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.text}
        </Alert>
      )}
      {!canPropose && (
        <Alert tone="info" title="View only">
          Proposing setting changes needs the “Propose changes” permission (Platform Administrator).
        </Alert>
      )}
      {scheduledAll.length > 0 && (
        <Alert tone="info" title={`${scheduledAll.length} scheduled ${scheduledAll.length === 1 ? 'change' : 'changes'}`}>
          {scheduledAll.map((c) => `${c.title} on ${date(c.effectiveAt)}. ${c.appliesTo}.${c.status === 'pending_approval' ? ' Waiting for approval.' : c.approvedBy?.name ? ` Approved by ${c.approvedBy.name}.` : ''}`).join(' ')}
        </Alert>
      )}
      {overviewQ.isError || defsQ.isError ? (
        <LoadError error={overviewQ.error ?? defsQ.error} onRetry={() => void (overviewQ.isError ? overviewQ.refetch() : defsQ.refetch())} />
      ) : (
        <div className="ac-set">
          <nav className="ac-setnav only-desktop" aria-label="Settings sections">
            {sections.map((s, i) => (
              <Fragment key={s.key}>
                {i === productsAt && productsLink}
                <a
                  href="#"
                  className={cx(i === active && 'is-active')}
                  aria-current={i === active ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    goTo(i);
                  }}
                >
                  <Icon name={iconFor(sectionIcon(s.key), 'settings')} className="ic-sm" />
                  {s.title}
                </a>
              </Fragment>
            ))}
            {productsAt >= sections.length && productsLink}
          </nav>
          <div className="stack gap-5">
            {(overviewQ.isPending || defsQ.isPending) &&
              [0, 1, 2].map((n) => (
                <Card key={n} className="ac-sect" title={<span className="sk sk-line" />} titleClassName="h3">
                  <SkeletonLines rows={3} />
                </Card>
              ))}
            {!overviewQ.isPending && !defsQ.isPending && (
              <>
                {sections.slice(0, productsAt).map((s, i) => sectionCard(s, i))}
                <ProductImageSettingsCard id="set-products" />
                {sections.slice(productsAt).map((s, i) => sectionCard(s, i + productsAt))}
              </>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={view === 'review-change' && !!change}
        onClose={closeReview}
        size="lg"
        title="Review change before saving"
        foot={
          <>
            <Button variant="ghost" onClick={closeReview}>
              Back to editing
            </Button>
            {change?.impact.needsApproval ? (
              <Button icon="send" onClick={confirm} disabled={submitM.isPending || patchM.isPending || !!change.impact.blocking.length}>
                Send for approval
              </Button>
            ) : (
              <Button icon="check" onClick={confirm} disabled={submitM.isPending || patchM.isPending || !!change?.impact.blocking.length}>
                Save change
              </Button>
            )}
          </>
        }
      >
        {change && (
          <>
            {change.items.map((it) => (
              <div className="stack gap-1" key={it.key}>
                <span className="eyebrow">
                  {shownSection?.title ?? it.section} · {it.label}
                </span>
                <span className="h4">
                  <span className="ac-ba">
                    <span className="b">{it.fromText}</span>
                    <Icon name="arrow-right" />
                    <span className="a">{it.toText}</span>
                  </span>
                </span>
              </div>
            ))}
            <div className="ac-fgrid">
              <Field
                label="Effective date"
                hint={(() => {
                  const lead = Math.max(0, ...change.items.map((it) => defs.get(it.key)?.minLeadDays ?? 0));
                  return lead ? `At least ${lead} days from today, so sellers and Help content can update.` : 'The change can start today.';
                })()}
                error={errors.effective}
              >
                <TextInput id="se-m-eff" type="date" icon="calendar" min={dayFromToday(0)} value={effective} onChange={(e) => changeEffective(e.target.value)} />
              </Field>
              <Field label="Applies to">
                <Select
                  id="se-m-scope"
                  options={SCOPE_OPTIONS.filter((o) => change.items.every((it) => defs.get(it.key)?.applyScopes.includes(o.value) ?? true))}
                  value={scope}
                  onChange={(e) => changeScope(e.target.value as ApplyScope)}
                />
              </Field>
            </div>
            <div className="stack gap-2">
              <span className="small strong">Impact on existing commitments</span>
              {change.impact.items.length ? (
                <ul className="list">
                  {change.impact.items.map((im, n) => (
                    <li key={n}>
                      <Icon name={im.severity === 'blocking' ? 'circle-x' : im.severity === 'warning' ? 'triangle-alert' : 'info'} className="ic-sm" />
                      <span className="small grow">
                        {im.count != null && (
                          <>
                            <b>{im.count.toLocaleString('en-US')}</b>{' '}
                          </>
                        )}
                        {im.message}
                        {im.owner ? ` (${im.owner})` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="small muted">No open orders, sellers or content are affected.</span>
              )}
            </div>
            {change.impact.blocking.length > 0 && (
              <Alert tone="danger" title="This change can’t be saved yet">
                {change.impact.blocking.join(' ')}
              </Alert>
            )}
            {patchM.isError && (
              <Alert tone="danger" title="The preview wasn’t updated">
                {errorMessage(patchM.error)}
              </Alert>
            )}
            <Field label="Reason (required)" error={errors.reason ?? (submitM.error instanceof ApiError ? submitM.error.fieldErrors.reason : undefined)}>
              <Textarea
                id="se-m-reason"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (e.target.value.trim()) setErrors((x) => ({ ...x, reason: undefined }));
                }}
              />
            </Field>
            {submitM.isError && (
              <Alert tone="danger" title="The change wasn’t saved">
                {errorMessage(submitM.error)}
              </Alert>
            )}
            {change.impact.needsApproval && (
              <Alert tone="warning" title={change.impact.approvalRule === 'business_owner' ? 'Needs Business Owner approval' : 'Needs a second reviewer'}>
                {shownSection?.title ?? 'This'} change is approved by {change.impact.approvers.join(' or ') || (change.impact.approvalRule === 'business_owner' ? 'the Business Owner' : 'a second reviewer')}. The change is scheduled only after approval.
              </Alert>
            )}
          </>
        )}
      </Dialog>
    </AdminLayout>
  );
}
