import { useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useView } from '@/lib/hooks';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import { Alert, Button, Card, Checkbox, Dialog, Field, Icon, KeyValue, LogoTile, PageHeader, Select, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput } from '@/ui';
import {
  CARRIERS, DESTINATIONS, FREE_RULES, NOTICE_AUDIENCE, NOTICE_CARRIERS, NOTICE_DELAYS, NOTICE_PLACES, NOTICE_SAMPLE, NOTICE_TYPES, NOTICES, OFFICIAL_DISPATCH, RATES, SELLER_TARGETS,
  type ServiceNotice,
} from './data/shipping';

// Design: pages/admin/admin-shipping.html · view "add-service-notice" = the add notice dialog.

type Section = 'carriers' | 'destinations' | 'dispatch' | 'calendar' | 'free';
const SECTIONS: Array<{ value: Section; label: string }> = [
  { value: 'carriers', label: 'Carriers and methods' },
  { value: 'destinations', label: 'Destinations' },
  { value: 'dispatch', label: 'Dispatch targets' },
  { value: 'calendar', label: 'Calendar and notices' },
  { value: 'free', label: 'Free shipping' },
];
const sectionId = (s: Section) => `aa-sh-${s}`;

interface NoticeDraft {
  title: string;
  type: string;
  carrier: string;
  area: string;
  from: string;
  until: string;
  delay: string;
  audience: string;
  message: string;
  places: Record<string, boolean>;
}
const ALL_PLACES = Object.fromEntries(NOTICE_PLACES.map((p) => [p.id, true]));
const BLANK: NoticeDraft = { title: '', type: NOTICE_TYPES[0], carrier: 'All carriers', area: '', from: '', until: '', delay: '+1 business day', audience: NOTICE_AUDIENCE[0], message: '', places: ALL_PLACES };
const MSG_MAX = 200;
const TODAY = new Date(2026, 9, 10);

function validate(d: NoticeDraft, publish: boolean) {
  const e: Partial<Record<keyof NoticeDraft, string>> = {};
  if (!d.title.trim()) e.title = 'Enter a notice title.';
  if (!publish) return e;
  if (!d.area.trim()) e.area = 'Enter the affected area: ZIP prefixes, states or zones.';
  if (!d.from.trim()) e.from = 'Enter a start date.';
  if (!d.until.trim()) e.until = 'Enter an end date.';
  if (!d.message.trim()) e.message = 'Write the message customers see.';
  else if (d.message.length >= MSG_MAX) e.message = `Keep the message under ${MSG_MAX} characters (${d.message.length} now).`;
  if (!Object.values(d.places).some(Boolean)) e.places = 'Choose at least one place to show the notice.';
  return e;
}

/** "Tue, Oct 6, 2026" -> { mon: 'Oct', day: 6, date } */
function parseDay(s: string) {
  const m = s.match(/([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?/);
  if (!m) return null;
  const date = new Date(`${m[1]} ${m[2]}, ${m[3] ?? TODAY.getFullYear()}`);
  return { mon: m[1], day: Number(m[2]), date: isNaN(date.getTime()) ? null : date };
}

/** Oct 6 + Oct 11 -> "Oct 6–11"; Oct 30 + Nov 2 -> "Oct 30 – Nov 2". */
function whenLabel(from: string, until: string) {
  const a = parseDay(from);
  const b = parseDay(until);
  if (!a || !b) return [from, until].filter(Boolean).join(' – ');
  if (a.mon === b.mon) return a.day === b.day ? `${a.mon} ${a.day}` : `${a.mon} ${a.day}–${b.day}`;
  return `${a.mon} ${a.day} – ${b.mon} ${b.day}`;
}

const andList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export default function Shipping() {
  const [view, setView] = useView<'add-service-notice'>();
  const [section, setSection] = useState<Section>('carriers');
  const [carriers, setCarriers] = useState(CARRIERS);
  const [notices, setNotices] = useState<ServiceNotice[]>(NOTICES);
  const [flash, setFlash] = useState('');
  // The design's "add-service-notice" view shows the dialog filled in.
  const [draft, setDraft] = useState<NoticeDraft>(() => (view === 'add-service-notice' ? { ...NOTICE_SAMPLE, places: ALL_PLACES } : BLANK));
  const [tried, setTried] = useState<'' | 'draft' | 'publish'>('');

  const open = view === 'add-service-notice';
  const errors = tried ? validate(draft, tried === 'publish') : {};
  const live = notices.filter((n) => n.status === 'Live');
  const set = <K extends keyof NoticeDraft>(k: K, v: NoticeDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const jump = (s: Section) => {
    setSection(s);
    document.getElementById(sectionId(s))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const toggleMethod = (ci: number, mi: number, on: boolean) =>
    setCarriers((cs) => cs.map((c, i) => (i !== ci ? c : { ...c, methods: c.methods.map((m, j) => (j === mi ? { ...m, on } : m)) })));

  const openNotice = () => {
    setDraft(BLANK);
    setTried('');
    setView('add-service-notice');
  };
  const close = () => setView('');

  const save = (publish: boolean) => {
    setTried(publish ? 'publish' : 'draft');
    if (Object.keys(validate(draft, publish)).length) return;
    const [carrierShort] = NOTICE_CARRIERS[draft.carrier];
    const [delayShort] = NOTICE_DELAYS[draft.delay];
    const when = whenLabel(draft.from, draft.until);
    const start = parseDay(draft.from)?.date;
    const status: ServiceNotice['status'] = !publish ? 'Draft' : start && start > TODAY ? 'Scheduled' : 'Live';
    const places = NOTICE_PLACES.filter((p) => draft.places[p.id]).map((p) => p.short);
    const notice: ServiceNotice = {
      id: `sn${Date.now()}`,
      when: when || 'Not set',
      title: draft.title.trim(),
      effect: `${carrierShort} ${delayShort}`,
      status,
      banner: `${draft.title.trim()}: ${carrierShort} ${draft.delay}, ${when}. Shown on ${andList(places)}.`,
    };
    setNotices((ns) => [notice, ...ns]);
    setFlash(status === 'Draft' ? `"${notice.title}" saved as a draft. Customers don't see it until you publish it.` : status === 'Live' ? `"${notice.title}" is live. Delivery estimates now include the delay.` : `"${notice.title}" is scheduled and goes live on ${draft.from}.`);
    close();
  };

  const [, previewService] = NOTICE_CARRIERS[draft.carrier];
  const [, previewArrival] = NOTICE_DELAYS[draft.delay];
  const paused = draft.delay === 'Pause delivery to this area';

  return (
    <AdminLayout active="shipping">
      <PageHeader
        crumbs={[{ label: 'Commerce' }, { label: 'Shipping' }]}
        title="Platform shipping settings"
        sub="Owner Theo Grant, Shipping Manager · changes show their effective date and apply to new orders only"
        actions={
          <>
            <Button variant="secondary" size="sm" icon="truck" to={href('ops/dispatch')}>
              Dispatch and exceptions
            </Button>
            <Button size="sm" icon="plus" to={href('admin/shipping', 'add-service-notice')} onClick={(e) => (e.preventDefault(), openNotice())}>
              Add service notice
            </Button>
          </>
        }
      />
      {live.length > 0 && (
        <Alert tone="warning" title={live.length === 1 ? '1 service notice is live' : `${live.length} service notices are live`}>
          {live.map((n) => n.banner ?? `${n.title}: ${n.effect}, ${n.when}.`).join(' ')}
        </Alert>
      )}
      {flash && (
        <Alert tone="success" title="Service notice saved">
          {flash}
        </Alert>
      )}
      <Tabs items={SECTIONS} active={section} onChange={jump} />
      <div className="aa-carrier" id={sectionId('carriers')}>
        {carriers.map((c, ci) => {
          const active = c.methods.some((m) => m.on);
          return (
            <Card
              key={c.name}
              title={c.name}
              sub={`Account ${c.account} · connected`}
              titleAs={ci === 0 ? 'h2' : 'h3'}
              actions={<StatusBadge status={active ? 'Active' : 'Paused'} />}
            >
              <ul className="list">
                {c.methods.map((m, mi) => {
                  const id = `aa-sh-${c.name}-${m.name.replace(/\s+/g, '')}`;
                  return (
                    <li key={m.name}>
                      <span className="grow stack gap-0">
                        <span className="small strong">{m.name}</span>
                        <span className="xs muted">{m.eta}</span>
                      </span>
                      <Switch id={id} checked={m.on} onChange={(e) => toggleMethod(ci, mi, e.target.checked)} label={<span className="sr-only">{`${c.name} ${m.name} enabled`}</span>} />
                    </li>
                  );
                })}
              </ul>
              <span className="row between xs">
                <span className="muted">On-time delivery, 30 days</span>
                <b className="num">{c.onTime}</b>
              </span>
              <span className="xs muted">Tracking updates connected · last event 2 min ago</span>
            </Card>
          );
        })}
      </div>
      <Card
        title="Shipping methods and rates"
        sub="Official Store rates · sellers set their own within these methods"
        titleAs="h3"
        flush
        actions={
          <Button variant="secondary" size="sm" icon="pencil">
            Edit rates
          </Button>
        }
      >
        <TableWrap label="Shipping methods and rates table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Method</th>
                <th scope="col">Customer sees</th>
                <th scope="col">Carriers</th>
                <th className="r" scope="col">Up to 2 lb</th>
                <th className="r" scope="col">2–10 lb</th>
                <th className="r" scope="col">Over 10 lb</th>
                <th scope="col">Free when</th>
              </tr>
            </thead>
            <tbody>
              {RATES.map((r) => (
                <tr key={r.method}>
                  <td>
                    <span className="small strong">{r.method}</span>
                  </td>
                  <td>
                    <span className="small">{r.sees}</span>
                  </td>
                  <td>
                    <span className="small">{r.carriers}</span>
                  </td>
                  <td className="r">{money(r.r1)}</td>
                  <td className="r">{money(r.r2)}</td>
                  <td className="r">{money(r.r3)}</td>
                  <td>{r.free ? <span className="small">{r.free}</span> : <span className="xs muted">Never</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>
      <div className="aa-2">
        <Card id={sectionId('destinations')} title="Destinations" sub="One service region at launch" titleAs="h3">
          <ul className="list">
            {DESTINATIONS.map((d) => (
              <li key={d.title}>
                <Icon name={d.icon} className="ic-sm" />
                <span className="grow stack gap-0">
                  <span className="small strong">{d.title}</span>
                  <span className="xs muted">{d.sub}</span>
                </span>
                {d.badge && <StatusBadge status={d.badge} />}
              </li>
            ))}
          </ul>
        </Card>
        <Card id={sectionId('dispatch')} title="Dispatch targets" sub="Late dispatch creates an overdue task and notifies the customer" titleAs="h3">
          <div className="aa-sec">
            <span className="row gap-2">
              <LogoTile initials="M" tint="brand" size="xs" />
              <span className="h4">Official Store</span>
            </span>
            <KeyValue
              pairs={[
                ...OFFICIAL_DISPATCH,
                [
                  'Current',
                  <>
                    <span className="t-success-text strong">98.6% on time</span> · 30 days
                  </>,
                ],
              ]}
            />
          </div>
          <div className="aa-sec">
            <span className="h4">Default seller targets</span>
            <KeyValue pairs={SELLER_TARGETS} />
            <span className="xs muted">Example targets. Final service standards are in the seller agreement.</span>
          </div>
        </Card>
      </div>
      <div className="aa-2">
        <Card
          id={sectionId('calendar')}
          title="Holiday calendar and service notices"
          sub="Customers see these in delivery estimates"
          titleAs="h3"
          flush
          actions={
            <Button variant="ghost" size="sm" icon="plus" to={href('admin/shipping', 'add-service-notice')} onClick={(e) => (e.preventDefault(), openNotice())}>
              Add
            </Button>
          }
        >
          <TableWrap label="Holiday calendar and service notices table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Notice</th>
                  <th scope="col">Effect</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {notices.map((n) => {
                  const atRisk = n.status === 'Live';
                  return (
                    <tr key={n.id} className={cx(atRisk && 'is-warn')}>
                      <td>
                        {atRisk && <span className="sr-only">At risk: </span>}
                        <span className="small nowrap">{n.when}</span>
                      </td>
                      <td>
                        <span className="small">{n.title}</span>
                      </td>
                      <td>
                        <span className="small">{n.effect}</span>
                      </td>
                      <td>
                        <StatusBadge status={n.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
          {live.length > 0 && (
            <p className="status-legend status-legend--edge">
              <span className="sr-only">Legend: </span>
              <span className="sl sl-warning">
                <i aria-hidden="true" />
                Amber edge = at risk: due soon or near target
              </span>
            </p>
          )}
        </Card>
        <Card id={sectionId('free')} title="Free-shipping rules" sub="Who pays is recorded per order" titleAs="h3">
          <ul className="list">
            {FREE_RULES.map((r) => (
              <li key={r.title}>
                <span className="grow stack gap-0">
                  <span className="small strong">{r.title}</span>
                  <span className="xs muted">{r.sub}</span>
                </span>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
          <Link className="small strong" to={href('admin/promotions')}>
            Manage shipping promotions
          </Link>
        </Card>
      </div>

      <Dialog
        open={open}
        onClose={close}
        title="Add service notice"
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => save(false)}>
              Save as draft
            </Button>
            <Button icon="megaphone" onClick={() => save(true)}>
              Publish notice
            </Button>
          </>
        }
      >
        <p className="small sub">Service notices adjust delivery estimates and show a short message to customers where they make delivery decisions.</p>
        <div className="grid md2 gap-3">
          <Field label="Notice title" error={errors.title}>
            <TextInput id="aa-sn-t" value={draft.title} error={!!errors.title} onChange={(e) => set('title', e.target.value)} placeholder="" />
          </Field>
          <Field label="Type">
            <Select id="aa-sn-type" options={NOTICE_TYPES} value={draft.type} onChange={(e) => set('type', e.target.value)} />
          </Field>
          <Field label="Carriers and services">
            <Select id="aa-sn-c" options={Object.keys(NOTICE_CARRIERS)} value={draft.carrier} onChange={(e) => set('carrier', e.target.value)} />
          </Field>
          <Field label="Affected area" hint="ZIP prefixes, states or zones" error={errors.area}>
            <TextInput id="aa-sn-a" value={draft.area} error={!!errors.area} onChange={(e) => set('area', e.target.value)} placeholder="" />
          </Field>
          <Field label="From" error={errors.from}>
            <TextInput id="aa-sn-from" value={draft.from} error={!!errors.from} onChange={(e) => set('from', e.target.value)} placeholder="" />
          </Field>
          <Field label="Until" hint="Ends automatically. You can end it early." error={errors.until}>
            <TextInput id="aa-sn-to" value={draft.until} error={!!errors.until} onChange={(e) => set('until', e.target.value)} placeholder="" />
          </Field>
          <Field label="Add to delivery estimate">
            <Select id="aa-sn-add" options={Object.keys(NOTICE_DELAYS)} value={draft.delay} onChange={(e) => set('delay', e.target.value)} />
          </Field>
          <Field label="Applies to">
            <Select id="aa-sn-who" options={NOTICE_AUDIENCE} value={draft.audience} onChange={(e) => set('audience', e.target.value)} />
          </Field>
        </div>
        <Field label="Message to customers" hint="Plain language. Under 200 characters." error={errors.message}>
          <Textarea id="aa-sn-msg" value={draft.message} onChange={(e) => set('message', e.target.value)} placeholder="" />
        </Field>
        <div className="stack gap-2">
          <span className="label">Show on</span>
          <div className="grid md3 gap-2">
            {NOTICE_PLACES.map((p) => (
              <Checkbox key={p.id} id={p.id} label={p.label} checked={draft.places[p.id]} onChange={(e) => set('places', { ...draft.places, [p.id]: e.target.checked })} />
            ))}
          </div>
          {errors.places && (
            <span className="error-text">
              <Icon name="circle-alert" className="ic-sm" />
              {errors.places}
            </span>
          )}
        </div>
        <div className="aa-preview stack gap-2">
          <span className="xs strong muted">Preview · checkout, Sacramento 95814</span>
          <Alert tone="warning" icon="truck" title={paused ? 'Delivery paused' : 'Possible delay'}>
            {draft.message.trim() || 'Your message to customers appears here.'}
          </Alert>
          <span className="small">
            <b>{previewService}</b> · {previewArrival}
          </span>
        </div>
        <span className="xs muted">Sellers shipping to this area get a Seller Center notice. Dispatch deadlines do not change; only arrival estimates do.</span>
      </Dialog>
    </AdminLayout>
  );
}

