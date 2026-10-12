import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Drawer, Field, Icon, Img, KeyValue, SearchInput, SegmentedControl, Select, StatusBadge, TableWrap, Tabs, Textarea } from '@marketly/web-shared/ui';
import { CHECK_STYLE, GROUPS, REASONS, type Creative, type CreativeGroup, type CreativeStatus, type LinkCheck } from './data/ad-assets';

// Design: pages/admin/admin-ad-assets.html · view "review-creative" = review drawer for the Fall Home Sale creatives.

const TAB_STATUSES: Array<CreativeStatus | ''> = ['', 'In review', 'Changes requested', 'Approved', 'Rejected'];
const ADVERTISERS = [
  { value: '', label: 'Own and seller' },
  { value: 'own', label: 'Own promotions' },
  { value: 'seller', label: 'Seller paid' },
  { value: 'brand', label: 'Brand' },
];
const FORMATS = ['All formats', 'Opening full-screen', 'Banner', 'Pop-up', 'Sponsored product', 'Sponsored store', 'Ad text', 'Video'];
const LINKS: Array<{ value: '' | LinkCheck; label: string }> = [
  { value: '', label: 'Any link check' },
  { value: 'ok', label: 'Link works' },
  { value: 'warn', label: 'Needs attention' },
  { value: 'broken', label: 'Broken' },
];
const REVIEWABLE: CreativeStatus[] = ['In review', 'Changes requested'];

function Preview({ c }: { c: Creative }) {
  const p = c.preview;
  if (p.kind === 'txt') return <div className="pv"><span className="txt">{p.text}</span></div>;
  if (p.kind === 'video') return <div className="pv"><Img icon="video" tint={p.tint} className="wide" /></div>;
  return (
    <div className="pv">
      <span className="ab-adtag">{p.tag}</span>
      <Img icon="image" tint={p.tint} className={p.shape} />
    </div>
  );
}

function CheckLine({ c }: { c: Creative }) {
  const s = CHECK_STYLE[c.check.state];
  return (
    <span className={cx('xs row nowrap gap-1', s.cls)}>
      <Icon name={s.icon} className="ic-sm" />
      <span className="wrap">{c.check.text}</span>
    </span>
  );
}

function AdMock({ g, desk }: { g: NonNullable<CreativeGroup['review']>; desk?: boolean }) {
  return (
    <div className="ab-scrim">
      <div className={cx('ab-ad', desk && 'desk')}>
        <span className="ab-adtag">Ad</span>
        <button type="button" className="ab-adx" aria-label="Close advertisement">
          <Icon name="x" />
        </button>
        <div className="art">
          <Img icon="bed-double" tint="1" />
          <Img icon="lamp-desk" tint="5" />
        </div>
        <div className="copy">
          <b>{g.headline}</b>
          <span>{g.text}</span>
          <span className="cta">{g.button}</span>
        </div>
      </div>
    </div>
  );
}

const today = () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export default function AdAssets() {
  const [view, setView] = useView<'review-creative'>();
  const [groups, setGroups] = useState(GROUPS);
  const [tab, setTab] = useState<CreativeStatus | ''>('');
  const [q, setQ] = useState('');
  const [adv, setAdv] = useState('');
  const [fmt, setFmt] = useState(FORMATS[0]);
  const [link, setLink] = useState<'' | LinkCheck>('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [sel, setSel] = useState<{ group: string; creative: string }>({ group: 'g1', creative: 'a1' });
  const [decision, setDecision] = useState<'approve' | 'changes'>('approve');
  const [reason, setReason] = useState(REASONS[0]);
  const [comment, setComment] = useState(GROUPS[0].review?.comment ?? '');
  const [reasonErr, setReasonErr] = useState('');
  const [notice, setNotice] = useState('');
  const upload = useRef<HTMLInputElement>(null);

  const all = groups.flatMap((g) => g.creatives);
  const countFor = (s: CreativeStatus | '') => (s ? all.filter((c) => c.status === s).length : all.length);
  const needle = q.trim().toLowerCase();
  const visible = (g: CreativeGroup, c: Creative) =>
    (!tab || c.status === tab) &&
    (!adv || g.source === adv) &&
    (fmt === FORMATS[0] || c.formatGroup === fmt) &&
    (!link || c.check.state === link) &&
    (!needle || [c.file, g.name, g.advertiser].some((t) => t.toLowerCase().includes(needle)));
  const shown = groups.map((g) => ({ g, items: g.creatives.filter((c) => visible(g, c)) })).filter((x) => x.items.length);

  const group = groups.find((g) => g.id === sel.group) ?? groups[0];
  const review = group.review;
  const open = view === 'review-creative' && !!review;

  const openReview = (g: CreativeGroup, c: Creative) => {
    setSel({ group: g.id, creative: c.id });
    setDecision(c.status === 'Changes requested' ? 'changes' : 'approve');
    setReason(REASONS[0]);
    setComment(g.review?.comment ?? '');
    setReasonErr('');
    setView('review-creative');
  };
  const close = () => setView('');

  const decide = (d: 'approve' | 'changes') => {
    setDecision(d);
    if (d === 'changes' && reason === REASONS[0]) {
      setReasonErr('Choose what needs to change.');
      return;
    }
    const status: CreativeStatus = d === 'approve' ? 'Approved' : 'Changes requested';
    const note = d === 'approve' ? `Approved ${today()} by Noor Aziz.${comment.trim() ? ` ${comment.trim()}` : ''}` : `Noor Aziz: ${reason}.${comment.trim() ? ` ${comment.trim()}` : ''}`;
    setGroups((gs) => gs.map((g) => (g.id === group.id ? { ...g, creatives: g.creatives.map((c) => (REVIEWABLE.includes(c.status) ? { ...c, status, note } : c)) } : g)));
    const msg = d === 'approve' ? `${group.name}: creative approved` : `${group.name}: changes requested from the campaign owner`;
    setNotice(msg);
    announce(msg);
    close();
  };

  const onUpload = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const isVideo = f.type.startsWith('video');
    const c: Creative = {
      id: `u${Date.now()}`,
      file: f.name,
      status: 'Draft',
      preview: isVideo ? { kind: 'video', tint: '4' } : { kind: 'img', shape: 'wide', tint: '3', tag: 'Ad' },
      format: isVideo ? 'Video' : 'Not assigned to a placement',
      formatGroup: isVideo ? 'Video' : '',
      desc: '',
      size: `${Math.round(f.size / 1024)} KB`,
      check: { state: 'none', text: 'Add it to a campaign to run the checks' },
    };
    setGroups((gs) => {
      const up = gs.find((g) => g.id === 'uploads');
      if (up) return gs.map((g) => (g.id === 'uploads' ? { ...g, creatives: [c, ...g.creatives] } : g));
      return [{ id: 'uploads', name: 'New uploads', advertiser: 'Marketly', source: 'own', usedIn: 'Not used', creatives: [c] }, ...gs];
    });
    announce(`${f.name} uploaded as a draft`);
  };

  return (
    <AdminLayout active="ad-assets">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Advertisements', to: href('admin/ads') }, { label: 'Creative library' }]} />
          <h1 className="h1">Ad creative library</h1>
          <p className="sub small">Images, ad text, video and destination links for every campaign · reviewed by Advertising and Content</p>
        </div>
        <div className="actions">
          <input ref={upload} type="file" hidden accept="image/jpeg,image/png,video/mp4" onChange={(e) => onUpload(e.target.files)} />
          <Button size="sm" icon="upload" onClick={() => upload.current?.click()}>
            Upload creative
          </Button>
        </div>
      </div>

      <Tabs items={TAB_STATUSES.map((s) => ({ label: s || 'All', value: s, count: countFor(s) }))} active={tab} onChange={setTab} />

      <div className="toolbar">
        <SearchInput id="aa-q" placeholder="Search file name, campaign or advertiser" value={q} onChange={setQ} />
        <Select id="aa-adv" aria-label="Advertiser" options={ADVERTISERS} value={adv} onChange={(e) => setAdv(e.target.value)} />
        <Select id="aa-fmt" aria-label="Format" options={FORMATS} value={fmt} onChange={(e) => setFmt(e.target.value)} />
        <Select id="aa-link" aria-label="Link type" options={LINKS} value={link} onChange={(e) => setLink(e.target.value as '' | LinkCheck)} />
        <SegmentedControl
          items={[
            { label: 'Grid', value: 'grid', icon: 'layout-grid' },
            { label: 'List', value: 'list', icon: 'list' },
          ]}
          active={layout}
          onChange={setLayout}
          label="Layout"
        />
      </div>
      <p className="ab-note">
        <Icon name="info" className="ic-sm" /> Required sizes: opening ad 1600 × 900 desktop and 1080 × 1920 phone; banners 1440 × 360 and 750 × 500; JPG or PNG up to 1 MB. Video is stored but not shown until video placements are turned on.
      </p>

      {notice && <Alert tone="success" title={notice} />}

      <div className="stack gap-4">
        {shown.length === 0 && (
          <div className="card pad">
            <p className="small muted">No creatives match these filters.</p>
          </div>
        )}
        {shown.map(({ g, items }, gi) => {
          const H = gi === 0 ? 'h2' : 'h3';
          return (
            <section className="card" key={g.id}>
              <div className="card-head">
                <div className="stack gap-0">
                  <H className="h4">{g.name}</H>
                  <span className="xs muted">
                    {g.advertiser} · used in: {g.usedIn}
                    {g.campaignStatus ? ` · ${g.campaignStatus}` : ''}
                    {g.extra ? ` · ${g.extra}` : ''}
                  </span>
                </div>
                <div className="row gap-2">{g.source === 'own' ? <Badge tone="brand">Own</Badge> : <Badge tone="info">Paid</Badge>}</div>
              </div>
              {layout === 'grid' ? (
                <div className="card-body">
                  <div className="ab-tiles">
                    {items.map((c) => (
                      <article key={c.id} className={cx('ab-tile', open && sel.creative === c.id && 'is-sel')}>
                        <Preview c={c} />
                        <div className="bd">
                          <div className="row between gap-1-5">
                            <span className="small strong truncate">{c.file}</span>
                            <StatusBadge status={c.status} />
                          </div>
                          <span className="xs muted">{c.format}</span>
                          <span className="xs num">{c.size}</span>
                          <CheckLine c={c} />
                          {c.note && <span className="note">{c.note}</span>}
                          <span className="row gap-2 mt-auto">
                            {REVIEWABLE.includes(c.status) && g.review ? (
                              <Button variant="secondary" size="sm" onClick={() => openReview(g, c)}>
                                Review
                              </Button>
                            ) : (
                              <Button variant="ghost" size="sm" to={g.campaignStatus ? href('admin/ad-campaign', 'creative-preview') : undefined}>
                                View
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" icon="download" label={`Download ${c.file}`} />
                          </span>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : (
                <TableWrap label={`${g.name} creatives table`}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">File</th>
                        <th scope="col">Format</th>
                        <th scope="col">Size</th>
                        <th scope="col">Check</th>
                        <th scope="col">Status</th>
                        <th className="col-pin" scope="col">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((c) => (
                        <tr key={c.id}>
                          <td className="strong">{c.file}</td>
                          <td>{c.format}</td>
                          <td className="num nowrap">{c.size}</td>
                          <td>
                            <CheckLine c={c} />
                          </td>
                          <td>
                            <StatusBadge status={c.status} />
                          </td>
                          <td className="col-pin">
                            {REVIEWABLE.includes(c.status) && g.review ? (
                              <Button variant="secondary" size="sm" onClick={() => openReview(g, c)}>
                                Review
                              </Button>
                            ) : (
                              <Button variant="ghost" size="sm" icon="download" label={`Download ${c.file}`} />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </section>
          );
        })}
      </div>

      {review && (
        <Drawer
          open={open}
          onClose={close}
          title={`Review creative: ${group.name}`}
          foot={
            <>
              <Button variant="secondary" size="sm" onClick={() => decide('changes')}>
                Request changes
              </Button>
              <Button size="sm" icon="check" onClick={() => decide('approve')}>
                Approve creative
              </Button>
            </>
          }
        >
          <KeyValue
            pairs={[
              ['Advertiser', review.advertiser],
              ['Files', group.creatives.map((c) => (c.file === 'Ad text' ? 'ad text' : c.file)).join(' · ')],
              ['Destination', review.destination],
              [
                'Campaign',
                <>
                  <Link to={href('admin/ad-campaign', 'approval')} className="link-inline">
                    {group.usedIn}
                  </Link>{' '}
                  · {review.period}
                </>,
              ],
            ]}
          />
          {group.source === 'own' && (
            <div className="ab-dpair ab-sm">
              <div className="stack gap-1">
                <span className="xs strong sub">
                  <Icon name="monitor" className="ic-sm" /> Desktop
                </span>
                <div className="ab-dframe">
                  <div className="ab-dbar">
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="ab-screen desk">
                    <div className="sk h-18" />
                    <div className="sk h-46" />
                    <div className="sk u-h-12px" style={{ width: '60%' }} />
                    <div className="sk h-30" />
                    <AdMock g={review} desk />
                  </div>
                </div>
              </div>
              <div className="stack gap-1">
                <span className="xs strong sub">
                  <Icon name="smartphone" className="ic-sm" /> Phone
                </span>
                <div className="ab-mframe">
                  <div className="ab-screen mob">
                    <div className="sk h-18" />
                    <div className="sk h-46" />
                    <div className="sk u-h-12px" style={{ width: '60%' }} />
                    <div className="sk h-30" />
                    <div className="sk h-30" />
                    <div className="sk h-18" />
                    <AdMock g={review} />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="panel stack gap-1">
            <span className="small strong">{review.headline}</span>
            <span className="xs sub">
              {review.text} · button "{review.button}"
            </span>
          </div>
          <span className="h4">Checks</span>
          <ul className="ab-checks">
            {review.checks.map((c) => (
              <li key={c.t} className={`t-${c.tone}`}>
                <span className="sr-only">{c.tone === 'ok' ? 'Passed: ' : 'Warning: '}</span>
                <Icon name={c.tone === 'ok' ? 'circle-check' : 'triangle-alert'} className="ic-sm" />
                <span className="stack gap-0">
                  <span>{c.t}</span>
                  {c.d && <span className="xs muted">{c.d}</span>}
                </span>
              </li>
            ))}
          </ul>
          <span className="h4">Reviewer notes</span>
          <div className="ab-conv">
            {review.notes.map((n) => (
              <div key={n.who + n.when} className={cx('ab-msg', n.me ? 'is-note' : 'is-staff')}>
                <span className="who">
                  <b>{n.who}</b>
                  <Badge tone={n.tone}>{n.team}</Badge>
                  <span>{n.when}</span>
                </span>
                <p>{n.text}</p>
              </div>
            ))}
          </div>
          <fieldset className="stack gap-2 fieldset-reset">
            <legend className="label">Decision</legend>
            {(
              [
                ['approve', 'Approve', 'Campaign can be scheduled once all reviewers approve'],
                ['changes', 'Request changes', 'Sent to the campaign owner with your reason'],
              ] as const
            ).map(([v, t, b], i) => (
              <label key={v} className={cx('opt-card', decision === v && 'is-selected')} htmlFor={`aa-dec-${i + 1}`}>
                <input type="radio" name="aa-dec" id={`aa-dec-${i + 1}`} checked={decision === v} onChange={() => (setDecision(v), setReasonErr(''))} />
                <span className="stack gap-1 grow">
                  <span className="small strong">{t}</span>
                  <span className="small sub">{b}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Field label="Reason or note" error={reasonErr}>
            <Select id="aa-reason" options={REASONS} value={reason} onChange={(e) => (setReason(e.target.value), setReasonErr(''))} />
          </Field>
          <Field label="Comment for the owner" optional>
            <Textarea id="aa-note" value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
        </Drawer>
      )}
    </AdminLayout>
  );
}
