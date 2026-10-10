import { useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, Drawer, Field, Icon, IconButton, Img, SegmentedControl, Select, StatusBadge, TableWrap, TextInput, type IconName } from '@/ui';

// Design: pages/admin/admin-content.html · view "edit-section" = edit drawer for "Featured products: Fall picks".

interface Product { name: string; meta: string; icon: IconName; tint: string }
interface SectionEdit {
  heading: string;
  sub: string;
  source: string;
  products?: Product[];
  moreProducts?: number;
  from: string;
  to: string;
  tz: string;
  owner: string;
}
interface Section {
  id: string;
  title: string;
  icon: IconName;
  status: 'Published' | 'Scheduled' | 'Draft' | 'Ad position';
  summary: string;
  owner: string;
  when: string;
  /** Wireframe block in the preview (none for drafts). */
  wire: { cls: string; text: string };
  ad?: boolean;
  edit?: SectionEdit;
}

const FALL_PRODUCTS: Product[] = [
  { name: 'Mosswood Washed Linen Duvet Cover, Queen', meta: 'Casa Verde Home · 31 in stock', icon: 'bed-double', tint: '1' },
  { name: 'Brightline Smart LED Desk Lamp with Wireless Charger', meta: 'Marketly Official · 9 in stock', icon: 'lamp-desk', tint: '5' },
  { name: 'Mosswood Ceramic Pour-over Coffee Set', meta: 'Marketly Official · 58 in stock', icon: 'coffee', tint: '3' },
  { name: 'Pellar Pre-seasoned Cast Iron Skillet 26 cm', meta: 'Marketly Official · 77 in stock', icon: 'cooking-pot', tint: '3' },
];

const edit = (heading: string, owner: string, from = 'Always on', to = '', extra: Partial<SectionEdit> = {}): SectionEdit => ({ heading, sub: '', source: 'Manual selection', from, to, tz: 'Pacific Time (PT)', owner, ...extra });

const SECTIONS: Section[] = [
  { id: 'hero', title: 'Campaign banner', icon: 'image', status: 'Published', summary: 'Home Week: up to 30% off bedding, lighting and cookware', owner: 'Noor Aziz · Content', when: 'Oct 6 – Oct 19', wire: { cls: 'w-hero', text: 'Campaign banner · Home Week' }, edit: edit('Home Week: up to 30% off bedding, lighting and cookware', 'Noor Aziz · Content', 'Oct 6, 2026, 12:00 AM', 'Oct 19, 2026, 11:59 PM') },
  { id: 'ad1', title: 'Opening full-screen ad', icon: 'app-window', status: 'Ad position', summary: 'Controlled by Advertising · Home Week opening ad', owner: 'Jamie Brooks · Advertising', when: 'Oct 6 – Oct 19', wire: { cls: 'w-ad', text: 'Ad · opening full-screen (Advertising)' }, ad: true },
  { id: 'cats', title: 'Category shortcuts', icon: 'layout-grid', status: 'Published', summary: '8 categories', owner: 'Noor Aziz · Content', when: 'Always on', wire: { cls: 'w-cats', text: 'Category shortcuts' }, edit: edit('Shop by category', 'Noor Aziz · Content') },
  { id: 'deals', title: 'Deals', icon: 'tag', status: 'Published', summary: 'Flash deals from live campaigns', owner: 'Jamie Brooks · Marketing', when: 'Follows campaigns', wire: { cls: 'w-deals', text: 'Deals' }, edit: edit("Today's deals", 'Jamie Brooks · Marketing', 'Follows campaigns', '', { source: 'Rule: top sellers in Home & Kitchen' }) },
  { id: 'off', title: 'Official Store highlights', icon: 'badge-check', status: 'Published', summary: '4 products · chosen by Official Store', owner: 'Dana Ortiz · Official Store', when: 'Always on', wire: { cls: 'w-off', text: 'Official Store highlights' }, edit: edit('From the Official Store', 'Noor Aziz · Content') },
  { id: 'ad2', title: 'Sponsored brand banner', icon: 'megaphone', status: 'Ad position', summary: 'Controlled by Advertising · Halden Aurora', owner: 'Jamie Brooks · Advertising', when: 'Oct 1 – Oct 10', wire: { cls: 'w-ad', text: 'Ad · sponsored brand (Advertising)' }, ad: true },
  {
    id: 'feat', title: 'Featured products: Fall picks', icon: 'sparkles', status: 'Scheduled', summary: '12 products · manual selection', owner: 'Noor Aziz · Content', when: 'Oct 9, 6:00 AM – Oct 31', wire: { cls: 'w-feat', text: 'Featured: Fall picks · from Oct 9' },
    edit: { heading: 'Fall picks for home', sub: 'Warm layers, soft light and slow coffee', source: 'Manual selection', products: FALL_PRODUCTS, moreProducts: 8, from: 'Oct 9, 2026, 6:00 AM', to: 'Oct 31, 2026, 11:59 PM', tz: 'Pacific Time (PT)', owner: 'Noor Aziz · Content' },
  },
  { id: 'sell', title: 'Featured sellers', icon: 'store', status: 'Published', summary: '4 verified sellers', owner: 'Grace Kim · Sellers', when: 'Always on', wire: { cls: 'w-sell', text: 'Featured sellers' }, edit: edit('Sellers we love', 'Noor Aziz · Content') },
  { id: 'gift', title: 'Holiday gift guide teaser', icon: 'gift', status: 'Draft', summary: 'Draft copy and 3 collections', owner: 'Noor Aziz · Content', when: 'From Nov 1', wire: { cls: 'w-feat', text: 'Holiday gift guide' }, edit: edit('Holiday gift guide', 'Noor Aziz · Content', 'Nov 1, 2026, 12:00 AM', 'Dec 24, 2026, 11:59 PM') },
];

interface CampaignPage { name: string; path: string; owner: string; publish: string; remove: string; status: 'Published' | 'Scheduled' | 'Unpublished' | 'Draft' }
const PAGES: CampaignPage[] = [
  { name: 'Home Week', path: '/campaign/home-week', owner: 'Noor Aziz', publish: 'Oct 6, 12:00 AM', remove: 'Oct 19, 11:59 PM', status: 'Published' },
  { name: 'Fall Home Sale', path: '/campaign/fall-home-sale', owner: 'Noor Aziz', publish: 'Oct 16, 12:00 AM', remove: 'Oct 25, 11:59 PM', status: 'Scheduled' },
  { name: 'Kestrel flash sale', path: '/campaign/kestrel-flash', owner: 'Jamie Brooks', publish: 'Oct 9, 9:00 AM', remove: 'Oct 9, 9:00 PM', status: 'Scheduled' },
  { name: 'Back to campus', path: '/campaign/back-to-campus', owner: 'Noor Aziz', publish: 'Aug 15', remove: 'Removed Sep 16', status: 'Unpublished' },
  { name: 'Holiday gift guide', path: '/campaign/holiday-gifts', owner: 'Noor Aziz', publish: 'Not set', remove: 'Not set', status: 'Draft' },
];

interface Version { n: number; when: string; who: string; what: string }
const VERSIONS: Version[] = [
  { n: 14, when: 'Oct 6, 9:02 AM', who: 'Noor Aziz', what: 'Published Home Week banner, moved Deals above Official Store' },
  { n: 13, when: 'Oct 1, 8:15 AM', who: 'Jamie Brooks', what: 'Added Sponsored brand position' },
  { n: 12, when: 'Sep 16, 12:01 AM', who: 'System', what: 'Removed Back to campus banner on schedule' },
  { n: 11, when: 'Sep 2, 3:40 PM', who: 'Noor Aziz', what: 'Corrected category shortcut order' },
];

const SOURCES = ['Manual selection', 'Collection: Fall home', 'Rule: top sellers in Home & Kitchen'];
const TIME_ZONES = ['Pacific Time (PT)', 'Eastern Time (ET)'];
const OWNERS = ['Noor Aziz · Content', 'Jamie Brooks · Marketing'];

/** "Oct 9, 2026, 6:00 AM" -> "Oct 9, 6:00 AM"; "Oct 31, 2026, 11:59 PM" -> "Oct 31" */
const shortFrom = (s: string) => s.replace(/,\s*\d{4}/, '');
const shortTo = (s: string) => s.replace(/,\s*\d{4}.*$/, '');
const now = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function Content() {
  const [view, setView] = useView<'edit-section'>();
  const [sections, setSections] = useState(SECTIONS);
  const [published, setPublished] = useState(SECTIONS.map((s) => s.id));
  const [editId, setEditId] = useState<string | null>('feat');
  const [draft, setDraft] = useState<SectionEdit>(SECTIONS.find((s) => s.id === 'feat')!.edit!);
  const [position, setPosition] = useState(6);
  const [headErr, setHeadErr] = useState('');
  const [pages, setPages] = useState(PAGES);
  const [versions, setVersions] = useState(VERSIONS);
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [notice, setNotice] = useState('');

  const open = view === 'edit-section';
  const editing = sections.find((s) => s.id === editId);
  const reordered = sections.map((s) => s.id).join() !== published.join();
  const current = versions[0].n;

  const flash = (msg: string) => {
    setNotice(msg);
    announce(msg);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    setSections((l) => {
      const next = [...l];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    announce(`${sections[i].title} moved ${dir < 0 ? 'up' : 'down'}`);
  };
  const addVersion = (what: string) => {
    const v = { n: current + 1, when: now(), who: 'Noor Aziz', what };
    setVersions((vs) => [v, ...vs]);
    return v.n;
  };
  const publishOrder = () => {
    setPublished(sections.map((s) => s.id));
    const n = addVersion('Published new section order');
    flash(`Section order published as version ${n}`);
  };

  const openEdit = (s?: Section) => {
    if (s) {
      setEditId(s.id);
      setDraft({ ...s.edit! });
      setPosition(sections.findIndex((x) => x.id === s.id));
    } else {
      setEditId(null);
      setDraft(edit('', 'Noor Aziz · Content', 'Oct 12, 2026, 12:00 AM', 'Oct 31, 2026, 11:59 PM', { products: [] }));
      setPosition(sections.length);
    }
    setHeadErr('');
    setView('edit-section');
  };
  const close = () => setView('');
  const set = <K extends keyof SectionEdit>(k: K, v: SectionEdit[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    if (k === 'heading' && v) setHeadErr('');
  };

  const save = (status: 'Draft' | 'Scheduled') => {
    if (!draft.heading.trim()) {
      setHeadErr('Enter a heading.');
      return;
    }
    const when = draft.from === 'Always on' || draft.from === 'Follows campaigns' ? draft.from : `${shortFrom(draft.from)}${draft.to ? ` – ${shortTo(draft.to)}` : ''}`;
    const nProducts = (draft.products?.length ?? 0) + (draft.moreProducts ?? 0);
    setSections((l) => {
      let next: Section[];
      if (editing) {
        const updated: Section = {
          ...editing,
          status: editing.status === 'Published' && status === 'Scheduled' ? 'Published' : status,
          owner: draft.owner,
          when,
          summary: draft.products ? `${nProducts} products · ${draft.source.toLowerCase()}` : editing.summary,
          wire: editing.id === 'feat' ? { cls: 'w-feat', text: `Featured: ${draft.heading} · from ${shortTo(draft.from)}` } : editing.wire,
          edit: draft,
        };
        next = l.filter((s) => s.id !== editing.id);
        next.splice(Math.min(position, next.length), 0, updated);
      } else {
        const created: Section = { id: `s${Date.now()}`, title: `Featured products: ${draft.heading}`, icon: 'sparkles', status, summary: `${nProducts} products · ${draft.source.toLowerCase()}`, owner: draft.owner, when, wire: { cls: 'w-feat', text: `Featured: ${draft.heading}` }, edit: draft };
        next = [...l];
        next.splice(Math.min(position, next.length), 0, created);
      }
      return next;
    });
    const n = addVersion(`${status === 'Draft' ? 'Saved draft of' : 'Scheduled'} ${editing?.title ?? draft.heading}`);
    flash(status === 'Draft' ? `Draft saved as version ${n}` : `${draft.heading} scheduled for ${shortFrom(draft.from)} · version ${n}`);
    close();
  };
  const removeSection = () => {
    if (!editing) return close();
    setSections((l) => l.filter((s) => s.id !== editing.id));
    const n = addVersion(`Removed ${editing.title}`);
    flash(`${editing.title} removed · version ${n}. Restore it from Version history.`);
    close();
  };

  const posOpts = [
    { value: '0', label: '1 · top of the page' },
    ...sections.filter((s) => s.id !== editId).map((s, i) => ({ value: String(i + 1), label: `${i + 2} · after ${s.title}` })),
  ];

  const wire = sections
    .filter((s) => s.status !== 'Draft')
    .map((s) => (open && s.id === editId && s.id === 'feat' ? { ...s.wire, text: `Featured: ${draft.heading || '…'} · from ${shortTo(draft.from)}` } : s.wire));

  return (
    <AdminLayout active="content">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }]} />
          <h1 className="h1">Homepage and pages</h1>
          <p className="sub small">Owner Noor Aziz, Content Manager · ad positions and timing belong to Advertising · times in PT</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="eye" to={href('store/home')}>
            Preview homepage
          </Button>
          <Button size="sm" icon="plus" onClick={() => openEdit()}>
            Add section
          </Button>
        </div>
      </div>

      {notice && <Alert tone="success" title={notice} />}

      <div className="ab-main">
        <div className="stack gap-5">
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Homepage sections</h2>
                <span className="xs muted">Shown top to bottom · drag or use arrows to reorder · live version {current}</span>
              </div>
            </div>
            {sections.map((s, i) => (
              <div key={s.id} className={cx('ab-sec', s.ad && 'is-ad', open && s.id === editId && 'is-edit')}>
                <span className="handle">
                  <Icon name={s.ad ? 'lock' : 'grip-vertical'} className="ic-sm" />
                </span>
                <span className="row gap-2">
                  <span className="xs muted num">{i + 1}</span>
                  <Icon name={s.icon} className="ic-sm" />
                  <b className="small">{s.title}</b>
                  {s.ad ? <Badge tone="outline">Ad position</Badge> : <StatusBadge status={s.status} />}
                </span>
                <span className="meta">
                  <span>{s.summary}</span>
                  <span>
                    <Icon name="user-round" className="ic-sm" /> {s.owner}
                  </span>
                  <span>
                    <Icon name="calendar" className="ic-sm" /> {s.when}
                  </span>
                </span>
                <span className="acts">
                  {s.ad ? (
                    <Link className="small strong" to={href('admin/ads')}>
                      Managed in Advertisements
                    </Link>
                  ) : (
                    <>
                      <IconButton icon="arrow-up" label={`Move ${s.title} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton icon="arrow-down" label={`Move ${s.title} down`} disabled={i === sections.length - 1} onClick={() => move(i, 1)} />
                      <IconButton icon="eye" label={`Preview ${s.title}`} onClick={() => announce(`${s.title}: ${s.summary}`)} />
                      <Button variant="ghost" size="sm" to={href('admin/content', 'edit-section')} onClick={(e) => (e.preventDefault(), openEdit(s))}>
                        Edit
                      </Button>
                    </>
                  )}
                </span>
              </div>
            ))}
            <div className="card-foot">
              <span className="ab-note grow">{reordered ? 'Order changed: saved as a draft. Customers see it after you publish.' : 'Reordering saves a draft. Customers see it after you publish.'}</span>
              <Button variant="ghost" size="sm" disabled={!reordered} onClick={() => setSections((l) => published.map((id) => l.find((s) => s.id === id)).filter((s): s is Section => !!s).concat(l.filter((s) => !published.includes(s.id))))}>
                Discard draft
              </Button>
              <Button size="sm" disabled={!reordered} onClick={publishOrder}>
                Publish order
              </Button>
            </div>
          </section>

          <Card
            title="Campaign pages"
            titleAs="h3"
            sub="Each page has a publish time and a removal time"
            flush
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon="plus"
                onClick={() => {
                  setPages((p) => [...p, { name: 'Untitled campaign page', path: '/campaign/untitled', owner: 'Noor Aziz', publish: 'Not set', remove: 'Not set', status: 'Draft' }]);
                  announce('Campaign page draft added');
                }}
              >
                New campaign page
              </Button>
            }
          >
            <TableWrap label="Campaign pages table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Page</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Publish</th>
                    <th scope="col">Remove</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pages.map((p, i) => (
                    <tr key={p.path + i}>
                      <td>
                        <span className="ab-cell">
                          <span className="strong">{p.name}</span>
                          <span className="xs muted">{p.path}</span>
                        </span>
                      </td>
                      <td>{p.owner}</td>
                      <td>{p.publish}</td>
                      <td>{p.remove}</td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                      <td>
                        {p.status === 'Unpublished' ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              setPages((l) => l.map((x, j) => (j === i ? { ...x, status: 'Draft', publish: 'Not set', remove: 'Not set' } : x)));
                              announce(`${p.name} restored as a draft`);
                            }}
                          >
                            <Icon name="rotate-ccw" />
                            <span>Restore</span>
                            <span className="sr-only"> {p.name}</span>
                          </button>
                        ) : p.status === 'Draft' ? (
                          <Link className="btn btn-ghost btn-sm" to={href('store/collection')}>
                            <span>Edit</span>
                            <span className="sr-only"> {p.name}</span>
                          </Link>
                        ) : (
                          <Link className="btn btn-ghost btn-sm" to={href('store/collection')}>
                            <Icon name="eye" />
                            <span>Preview</span>
                            <span className="sr-only"> {p.name}</span>
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </div>

        <div className="stack gap-5">
          <Card title="Preview" titleAs="h3" sub={`${device === 'desktop' ? 'Desktop' : 'Phone'} homepage · draft`}>
            <div className="ab-wire" aria-label="Homepage layout preview" style={device === 'phone' ? { maxWidth: 220, marginInline: 'auto', width: '100%' } : undefined}>
              {wire.map((w, i) => (
                <div key={i} className={w.cls}>
                  {w.text}
                </div>
              ))}
            </div>
            <SegmentedControl
              items={[
                { label: 'Desktop', value: 'desktop', icon: 'monitor' },
                { label: 'Phone', value: 'phone', icon: 'smartphone' },
              ]}
              active={device}
              onChange={setDevice}
              label="Preview device"
            />
          </Card>
          <Card title="Version history" titleAs="h3" flush foot={<span className="ab-note grow">Restoring creates a new version. Nothing is overwritten.</span>}>
            <ul className="list pad">
              {versions.map((v, i) => (
                <li key={v.n}>
                  <span className="grow stack gap-0">
                    <span className="small strong">
                      v{v.n}
                      {i === 0 ? ' · live' : ''}
                    </span>
                    <span className="xs muted">
                      {v.when} · {v.who} · {v.what}
                    </span>
                  </span>
                  {i === 0 ? (
                    <Badge tone="brand">Current</Badge>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="rotate-ccw"
                      onClick={() => {
                        const n = addVersion(`Restored v${v.n}`);
                        flash(`v${v.n} restored as version ${n}`);
                      }}
                    >
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <Drawer
        open={open}
        onClose={close}
        title={editing ? `Edit section: ${editing.id === 'feat' ? 'Fall picks' : editing.title}` : 'Add section'}
        foot={
          <>
            <Button variant="danger-soft" size="sm" onClick={removeSection}>
              {editing ? 'Remove section' : 'Discard'}
            </Button>
            <span className="grow" />
            <Button variant="ghost" size="sm" onClick={() => save('Draft')}>
              Save draft
            </Button>
            <Button size="sm" onClick={() => save('Scheduled')}>
              Schedule
            </Button>
          </>
        }
      >
        <Field label="Heading" error={headErr}>
          <TextInput id="ct-head" value={draft.heading} error={!!headErr} onChange={(e) => set('heading', e.target.value)} />
        </Field>
        <Field label="Subheading" optional>
          <TextInput id="ct-sub" value={draft.sub} onChange={(e) => set('sub', e.target.value)} />
        </Field>
        <Field label="Product source">
          <Select id="ct-src" options={SOURCES} value={draft.source} onChange={(e) => set('source', e.target.value)} />
        </Field>
        {draft.products && (
          <div className="stack gap-2">
            <span className="label">Products ({draft.products.length + (draft.moreProducts ?? 0)})</span>
            {draft.products.length > 0 && (
              <ul className="list">
                {draft.products.map((p) => (
                  <li key={p.name}>
                    <Img icon={p.icon} tint={p.tint} className="tiny" />
                    <span className="grow stack gap-0">
                      <span className="small truncate">{p.name}</span>
                      <span className="xs muted">{p.meta}</span>
                    </span>
                    <IconButton icon="x" label={`Remove ${p.name}`} onClick={() => set('products', draft.products!.filter((x) => x !== p))} />
                  </li>
                ))}
              </ul>
            )}
            {(draft.moreProducts ?? 0) > 0 && <span className="xs muted">+ {draft.moreProducts} more · unavailable products are hidden automatically</span>}
            <Button
              variant="secondary"
              size="sm"
              icon="plus"
              onClick={() => {
                const pool = FALL_PRODUCTS.filter((p) => !draft.products!.includes(p));
                if (pool.length) set('products', [...draft.products!, pool[0]]);
                else set('moreProducts', (draft.moreProducts ?? 0) + 1);
              }}
            >
              Add products
            </Button>
          </div>
        )}
        <div className="ab-form-grid">
          <Field label="Show from">
            <TextInput id="ct-from" icon="calendar" value={draft.from} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="Remove at">
            <TextInput id="ct-to" icon="calendar" value={draft.to} onChange={(e) => set('to', e.target.value)} />
          </Field>
        </div>
        <Field label="Time zone">
          <Select id="ct-tz" options={TIME_ZONES} value={draft.tz} onChange={(e) => set('tz', e.target.value)} />
        </Field>
        <Field label="Position">
          <Select id="ct-pos" options={posOpts} value={String(Math.min(position, posOpts.length - 1))} onChange={(e) => setPosition(Number(e.target.value))} />
        </Field>
        <Field label="Owner">
          <Select id="ct-own" options={OWNERS.includes(draft.owner) ? OWNERS : [draft.owner, ...OWNERS]} value={draft.owner} onChange={(e) => set('owner', e.target.value)} />
        </Field>
        <Alert tone="info" title={`Saved as version ${current + 1}`}>
          Customers see this section at the scheduled time. Version {current} stays available to restore.
        </Alert>
      </Drawer>
    </AdminLayout>
  );
}
