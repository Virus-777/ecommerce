import { useState, type ReactNode } from 'react';
import { AdminLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, announce, Badge, Button, Card, Dialog, Field, Icon, KeyValue, PageHeader, Select, Switch, TableWrap, Textarea, TextInput } from '@/ui';
import {
  CARRIERS, COMMISSIONS, DESIGN_CHANGE, FIELDS, INITIAL_VALUES, PAYOUT_RULES, RETURN_EXCEPTIONS, RETURN_SHIPPING, SCOPES, SECTIONS, showValue,
  type Change, type SettingValue,
} from './data/settings';

// Design: pages/admin/admin-settings.html · view "review-change" = review dialog for the Electronics return window change.
// Editing a field never applies it: "Review change" opens the dialog (old → new, effective date, impact, reason),
// and only confirming saves it, or sends it to the Business Owner where the section needs approval.

const TODAY = 'Oct 10';

function Note({ children }: { children: ReactNode }) {
  return (
    <span className="xs muted row gap-1 nowrap wrap">
      <Icon name="info" className="ic-sm" />
      <span>{children}</span>
    </span>
  );
}

export default function Settings() {
  const [view, setView] = useView<'review-change'>();
  const [saved, setSaved] = useState<Record<string, SettingValue>>(INITIAL_VALUES);
  const [draft, setDraft] = useState<Record<string, SettingValue>>(INITIAL_VALUES);
  const [editing, setEditing] = useState<number[]>([]);
  const [meta, setMeta] = useState(() => SECTIONS.map((s) => ({ changed: s.changed, effective: s.effective })));
  const [pending, setPending] = useState<number[]>([]);
  const [active, setActive] = useState(view === 'review-change' ? DESIGN_CHANGE.section : 0);
  const [change, setChange] = useState<Change | null>(view === 'review-change' ? { ...DESIGN_CHANGE } : null);
  const [errors, setErrors] = useState<{ reason?: string; effective?: string }>({});
  const [notice, setNotice] = useState<{ title: string; text: string } | null>(null);

  const dirtyIds = (i: number) => SECTIONS[i].fields.filter((id) => draft[id] !== saved[id]);
  const set = (id: string, v: SettingValue) => setDraft((d) => ({ ...d, [id]: v }));

  const goTo = (i: number) => {
    setActive(i);
    document.getElementById(`set-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const startEdit = (i: number) => {
    setActive(i);
    setEditing((e) => (e.includes(i) ? e : [...e, i]));
    document.getElementById(SECTIONS[i].fields[0])?.focus();
  };
  const discard = (i: number) => {
    setDraft((d) => ({ ...d, ...Object.fromEntries(SECTIONS[i].fields.map((id) => [id, saved[id]])) }));
    setEditing((e) => e.filter((x) => x !== i));
  };
  const review = (i: number) => {
    const s = SECTIONS[i];
    const ids = dirtyIds(i);
    if (!ids.length) return;
    setActive(i);
    setErrors({});
    setChange({
      section: i,
      items: ids.map((id) => ({ eyebrow: `${s.title} · ${FIELDS[id].label}`, before: showValue(id, saved[id]), after: showValue(id, draft[id]) })),
      values: Object.fromEntries(ids.map((id) => [id, draft[id]])),
      effective: s.nextEffective,
      effectiveHint: s.effectiveHint,
      scope: SCOPES[0],
      impacts: s.impacts,
      reason: '',
      approval: s.approval,
    });
    setView('review-change');
  };

  const shown = change ?? DESIGN_CHANGE;
  const setChangeField = <K extends 'effective' | 'scope' | 'reason'>(k: K, v: Change[K]) => {
    setChange({ ...shown, [k]: v });
    if (k !== 'scope' && String(v).trim()) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const closeReview = () => setView('');

  const confirm = () => {
    const e = { reason: shown.reason.trim() ? undefined : 'Enter a reason for this change. It is saved in Action history.', effective: shown.effective.trim() ? undefined : 'Enter the date the change starts.' };
    if (e.reason || e.effective) {
      setErrors(e);
      document.getElementById(e.effective ? 'se-m-eff' : 'se-m-reason')?.focus();
      return;
    }
    const i = shown.section;
    const s = SECTIONS[i];
    const what = shown.items.map((it) => `${it.eyebrow}: ${it.before} → ${it.after}`).join('; ');
    if (shown.approval) {
      // Not applied yet: the live value stays until Morgan Hale approves.
      setPending((p) => (p.includes(i) ? p : [...p, i]));
      setDraft((d) => ({ ...d, ...Object.fromEntries(Object.keys(shown.values).map((id) => [id, saved[id]])) }));
      setMeta((m) => m.map((x, xi) => (xi === i ? { ...x, changed: `${TODAY} by Riley Chen (proposed), waiting for Morgan Hale` } : x)));
      setNotice({ title: `${s.title} change sent for approval`, text: `${what}. Morgan Hale, Business Owner, approves it before it is scheduled for ${shown.effective}. The current setting stays in place until then.` });
      announce(`${s.title} change sent for approval`);
    } else {
      setSaved((v) => ({ ...v, ...shown.values }));
      setMeta((m) => m.map((x, xi) => (xi === i ? { changed: `${TODAY} by Riley Chen`, effective: shown.effective } : x)));
      setNotice({ title: `${s.title} change saved`, text: `${what}. Effective ${shown.effective}. ${shown.scope}.` });
      announce(`${s.title} change saved`);
    }
    setEditing((x) => x.filter((n) => n !== i));
    setChange(null);
    setView('');
  };

  /* ---------- field and section rendering ---------- */

  const field = (id: string) => {
    const f = FIELDS[id];
    const v = draft[id];
    const control =
      f.kind === 'select' ? (
        <Select id={id} options={f.options ?? []} value={String(v)} onChange={(e) => set(id, e.target.value)} />
      ) : (
        <TextInput id={id} prefix={f.prefix} suffix={f.suffix} icon={f.icon} value={String(v)} onChange={(e) => set(id, e.target.value)} />
      );
    return (
      <Field label={f.label} hint={f.hint}>
        {control}
      </Field>
    );
  };
  const toggle = (id: string) => {
    const on = Boolean(draft[id]);
    return <Switch id={id} label={FIELDS[id].label} checked={on} aria-checked={on} data-switch="" onChange={(e) => set(id, e.target.checked)} />;
  };

  const section = (i: number, body: ReactNode, badge?: ReactNode) => {
    const s = SECTIONS[i];
    const dirty = dirtyIds(i).length > 0;
    const open = dirty || editing.includes(i);
    return (
      <Card
        className="ac-sect"
        id={`set-${i}`}
        title={s.title}
        titleClassName="h3"
        sub={s.sub}
        actions={
          <>
            {pending.includes(i) && (
              <Badge tone="warning" icon="hourglass">
                Approval pending
              </Badge>
            )}
            {badge}
            <Button variant="secondary" size="sm" icon="pencil" onClick={() => startEdit(i)}>
              Edit
            </Button>
          </>
        }
        footClassName="between"
        foot={
          <>
            <div className="ac-meta">
              <span>
                <Icon name="history" className="ic-sm" />
                Last changed {meta[i].changed}
              </span>
              <span>
                <Icon name="calendar-check" className="ic-sm" />
                Effective {meta[i].effective}
              </span>
            </div>
            {open && (
              <div className="row gap-2">
                <Button variant="ghost" size="sm" onClick={() => discard(i)}>
                  Discard
                </Button>
                <Button size="sm" icon="eye" disabled={!dirty} onClick={() => review(i)}>
                  Review change
                </Button>
              </div>
            )}
          </>
        }
      >
        {body}
      </Card>
    );
  };

  return (
    <AdminLayout active="settings">
      <PageHeader
        crumbs={[{ label: 'Reports and settings' }, { label: 'Settings' }]}
        title="Settings"
        sub="Market rules for the United States marketplace. Every change states its effective date and its effect on existing orders before you save."
        actions={
          <Button variant="secondary" size="sm" icon="history" to={href('admin/audit')}>
            View change history
          </Button>
        }
      />
      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.text}
        </Alert>
      )}
      <Alert tone="info" title="1 scheduled change">
        Electronics return window changes from 30 to 15 days on Nov 1, 2026. Orders placed before then keep 30 days. Approved by Morgan Hale on Oct 7.
      </Alert>
      <div className="ac-set">
        <nav className="ac-setnav only-desktop" aria-label="Settings sections">
          {SECTIONS.map((s, i) => (
            <a
              key={s.nav}
              href="#"
              className={cx(i === active && 'is-active')}
              aria-current={i === active ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                goTo(i);
              }}
            >
              <Icon name={s.navIcon} className="ic-sm" />
              {s.nav}
            </a>
          ))}
        </nav>
        <div className="stack gap-5">
          {section(
            0,
            <div className="ac-fgrid">
              {field('se-region')}
              {field('se-cur')}
              {field('se-tz')}
              {field('se-hours')}
              <div className="full">{field('se-hol')}</div>
            </div>,
          )}

          {section(
            1,
            <>
              <div className="ac-fgrid">
                {field('se-disp')}
                {field('se-cut')}
                {field('se-free')}
                {field('se-trk')}
                <div className="full stack gap-2">
                  <span className="label">Carrier services</span>
                  <div className="row gap-2">
                    {CARRIERS.map((c) => (
                      <Badge tone="outline" icon="truck" key={c}>
                        {c}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
              <Note>Example targets. Final dispatch standards are in the seller agreement.</Note>
            </>,
          )}

          {section(
            2,
            <>
              <div className="ac-fgrid">
                {field('se-rw')}
                {field('se-rt')}
              </div>
              <span className="small strong">Category exceptions</span>
              <TableWrap label="Returns baseline table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th scope="col">Window</th>
                      <th scope="col">Condition</th>
                      <th scope="col">Shown to customers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RETURN_EXCEPTIONS.map((r) => (
                      <tr key={r.category}>
                        <td>{r.category}</td>
                        <td>
                          {r.window}
                          {r.scheduled && (
                            <>
                              {' '}
                              <Badge tone="warning" icon="calendar-clock">
                                {r.scheduled}
                              </Badge>
                            </>
                          )}
                        </td>
                        <td>{r.condition}</td>
                        <td>{r.shown}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <span className="small strong">Who pays return shipping</span>
              <KeyValue pairs={RETURN_SHIPPING} />
              <Note>Example policy. Final windows and exceptions are a business decision.</Note>
            </>,
            <Badge tone="warning" icon="calendar-clock">
              Change scheduled
            </Badge>,
          )}

          {section(
            3,
            <>
              <div className="ac-fgrid">
                {field('se-basis')}
                {field('se-pfd')}
              </div>
              <TableWrap label="Fees table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th className="r" scope="col">
                        Commission
                      </th>
                      <th className="r" scope="col">
                        On a $100.00 sale
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMMISSIONS.map((c) => (
                      <tr key={c.category}>
                        <td>{c.category}</td>
                        <td className="r">
                          <b>{c.rate}%</b>
                        </td>
                        <td className="r">
                          {money(c.rate)} fee · {money(100 - c.rate)} to seller
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <Note>Example rates. Final fees are in the seller agreement. Cancellation, return and chargeback fee treatment is explained there too.</Note>
            </>,
          )}

          {section(
            4,
            <>
              <div className="ac-fgrid">
                {field('se-po')}
                {field('se-av')}
                {field('se-min')}
                {field('se-new')}
              </div>
              <ul className="list">
                {PAYOUT_RULES.map((r) => (
                  <li key={r.text}>
                    <Icon name={r.icon} className="ic-sm" />
                    <span className="small grow">{r.text}</span>
                  </li>
                ))}
              </ul>
              <Note>Example schedule and holds. Final payout timing is a business decision.</Note>
            </>,
          )}

          {section(
            5,
            <>
              <div className="ac-fgrid">
                {field('se-af')}
                {field('se-ov')}
                <div className="full">{field('se-noad')}</div>
              </div>
              <div className="stack gap-2">
                <span className="row gap-2">
                  <Switch id="se-label" label={'Require "Sponsored" or "Ad" label on every paid placement'} checked disabled onChange={() => undefined} aria-readonly="true" data-switch="" aria-checked="true" />
                  <Badge icon="lock">Always on</Badge>
                </span>
                {toggle('se-dismiss')}
                <span className="row gap-2">
                  {toggle('se-paid')}
                  <Badge tone="outline">Later</Badge>
                </span>
              </div>
            </>,
          )}

          {section(
            6,
            <div className="stack gap-3">
              {toggle('se-guest')}
              <span className="xs muted">Guests get an order link by email and can find orders with Guest order lookup using their email and order number.</span>
              {toggle('se-acc')}
            </div>,
          )}
        </div>
      </div>

      <Dialog
        open={view === 'review-change'}
        onClose={closeReview}
        size="lg"
        title="Review change before saving"
        foot={
          <>
            <Button variant="ghost" onClick={closeReview}>
              Back to editing
            </Button>
            {shown.approval ? (
              <Button icon="send" onClick={confirm}>
                Send for approval
              </Button>
            ) : (
              <Button icon="check" onClick={confirm}>
                Save change
              </Button>
            )}
          </>
        }
      >
        {shown.items.map((it) => (
          <div className="stack gap-1" key={it.eyebrow}>
            <span className="eyebrow">{it.eyebrow}</span>
            <span className="h4">
              <span className="ac-ba">
                <span className="b">{it.before}</span>
                <Icon name="arrow-right" />
                <span className="a">{it.after}</span>
              </span>
            </span>
          </div>
        ))}
        <div className="ac-fgrid">
          <Field label="Effective date" hint={shown.effectiveHint} error={errors.effective}>
            <TextInput id="se-m-eff" icon="calendar" value={shown.effective} onChange={(e) => setChangeField('effective', e.target.value)} />
          </Field>
          <Field label="Applies to">
            <Select id="se-m-scope" options={SCOPES} value={shown.scope} onChange={(e) => setChangeField('scope', e.target.value)} />
          </Field>
        </div>
        <div className="stack gap-2">
          <span className="small strong">Impact on existing commitments</span>
          <ul className="list">
            {shown.impacts.map((im) => (
              <li key={im.text}>
                <Icon name={im.icon} className="ic-sm" />
                <span className="small grow">
                  {im.strong && (
                    <>
                      <b>{im.strong}</b>{' '}
                    </>
                  )}
                  {im.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <Field label="Reason (required)" error={errors.reason}>
          <Textarea id="se-m-reason" value={shown.reason} onChange={(e) => setChangeField('reason', e.target.value)} />
        </Field>
        {shown.approval && (
          <Alert tone="warning" title="Needs Business Owner approval">
            {SECTIONS[shown.section].title} changes are approved by Morgan Hale. The change is scheduled only after approval.
          </Alert>
        )}
      </Dialog>
    </AdminLayout>
  );
}
