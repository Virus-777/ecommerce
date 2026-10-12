import { useState } from 'react';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, Field, Icon, KeyValue, Switch, TextInput, type IconName } from '@marketly/web-shared/ui';

// Design: pages/admin/admin-ad-placements.html

interface Rules {
  pages: string;
  formats: string;
  cap: string;
  priority: string;
  dismissal: string;
}
interface Placement {
  id: string;
  name: string;
  icon: IconName;
  stage: 'Launch' | 'Pilot' | 'Later';
  on: boolean;
  rules: Rules;
  /** Footer note: live campaigns, or what is needed to turn it on. */
  note: string;
}

const RULE_LABELS: Array<[keyof Rules, string]> = [
  ['pages', 'Pages'],
  ['formats', 'Formats'],
  ['cap', 'Frequency cap'],
  ['priority', 'When several ads qualify'],
  ['dismissal', 'Dismissal'],
];

const PLACEMENTS: Placement[] = [
  { id: '0', name: 'Opening full-screen', icon: 'app-window', stage: 'Launch', on: true, note: '1 live campaign', rules: { pages: 'Home, category and campaign entry pages', formats: 'Desktop 1600 × 900 · phone 1080 × 1920', cap: '1 per session · max 3 per visitor per 7 days', priority: 'Highest priority wins; equal priority rotates evenly', dismissal: 'Closing hides that campaign for 7 days' } },
  { id: '1', name: 'Home banner', icon: 'rectangle-horizontal', stage: 'Launch', on: true, note: '1 live campaign', rules: { pages: 'Home, below the campaign banner', formats: 'Desktop 1440 × 360 · phone 750 × 500', cap: 'No cap (in-page)', priority: 'Up to 3 rotate every 6 s by priority; rotation pauses on hover and focus', dismissal: 'Not dismissible' } },
  { id: '2', name: 'Category banner', icon: 'rectangle-horizontal', stage: 'Launch', on: true, note: '1 live campaign', rules: { pages: 'Top of category pages', formats: 'Desktop 1200 × 240 · phone 750 × 400', cap: 'No cap (in-page)', priority: 'Category match first, then priority', dismissal: 'Not dismissible' } },
  { id: '3', name: 'Promotional pop-up', icon: 'message-square', stage: 'Launch', on: true, note: '0 live campaigns', rules: { pages: 'Home, deals and campaign pages', formats: 'Desktop 640 × 480 · phone 600 × 800', cap: '1 per session · after 20 s or 50% scroll', priority: 'Skipped in any session where an opening ad already showed', dismissal: 'Closing hides that pop-up for 14 days' } },
  { id: '4', name: 'Sponsored product', icon: 'package', stage: 'Pilot', on: true, note: '2 live campaigns', rules: { pages: 'Search results, category lists, related products', formats: 'Product card with Sponsored label', cap: 'Max 2 per results page, positions 3 and 8', priority: 'Relevance to the search first, then bid priority', dismissal: 'Not dismissible' } },
  { id: '5', name: 'Sponsored store or brand', icon: 'store', stage: 'Later', on: false, note: 'Turn on when approval and billing are ready', rules: { pages: 'Home and discovery pages', formats: 'Desktop 1200 × 300 · phone 750 × 420', cap: '—', priority: 'Priority, then rotation', dismissal: '—' } },
  { id: '6', name: 'Floating panel', icon: 'panel-bottom', stage: 'Later', on: false, note: 'Turn on when approval and billing are ready', rules: { pages: 'Selected desktop and phone pages', formats: 'Strip, 72 px tall', cap: '1 per session', priority: 'One floating panel per page', dismissal: 'Closing hides it for the session' } },
  { id: '7', name: 'Interstitial', icon: 'layers', stage: 'Later', on: false, note: 'Turn on when approval and billing are ready', rules: { pages: 'Between browsing steps, outside checkout', formats: 'Desktop 1200 × 800 · phone 1080 × 1920', cap: '1 per day', priority: 'Priority', dismissal: 'Closing hides that campaign for 7 days' } },
];

const GLOBAL_RULES: Array<{ icon: IconName; t: string; d: string; locked?: boolean }> = [
  { icon: 'shield-check', t: 'Never cover checkout, payment results, tracking or returns', d: 'Overlays and interstitials are blocked on these pages' },
  { icon: 'layers', t: 'One overlay at a time', d: 'Opening ad, pop-up and interstitial never stack' },
  { icon: 'tag', t: 'Ad label required', d: '"Ad" on overlays and banners, "Sponsored" on product and store cards. Locked on for every placement and campaign.', locked: true },
  { icon: 'x', t: 'Visible close control', d: 'At least 44 px on phones, reachable with the keyboard, returns to the intended page' },
  { icon: 'package-x', t: 'Remove unavailable or expired ads', d: 'Ads stop when the promoted offer sells out or the campaign ends' },
  { icon: 'user-round', t: 'Seller behind promoted offers is named', d: 'Seller ad content is reviewed before it runs' },
];

export default function AdPlacements() {
  const [list, setList] = useState(PLACEMENTS);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Rules | null>(null);
  const [notice, setNotice] = useState('');

  const toggle = (p: Placement, on: boolean) => {
    setList((l) => l.map((x) => (x.id === p.id ? { ...x, on } : x)));
    const msg = `${p.name} ${on ? 'enabled' : 'turned off'}. The change applies to new displays now and is recorded in Action history.`;
    setNotice(msg);
    announce(msg);
  };
  const startEdit = (p: Placement) => {
    setEditing(p.id);
    setDraft({ ...p.rules });
  };
  const save = (p: Placement) => {
    if (!draft) return;
    setList((l) => l.map((x) => (x.id === p.id ? { ...x, rules: draft } : x)));
    setEditing(null);
    const msg = `${p.name} rules saved. The change applies to new displays now and is recorded in Action history.`;
    setNotice(msg);
    announce(msg);
  };

  return (
    <AdminLayout active="ads">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Advertisements', to: href('admin/ads') }, { label: 'Placements and rules' }]} />
          <h1 className="h1">Placements and rules</h1>
          <p className="sub small">Owner Jamie Brooks, Advertising Manager · changes take effect for new displays immediately and are recorded in Action history</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="history" to={href('admin/audit')}>
            Action history
          </Button>
        </div>
      </div>

      {notice && <Alert tone="success" title={notice} />}

      <Card title="Global rules" sub="Apply to every placement and campaign. The Ad label rule is always on and cannot be turned off; changing the others needs Business Owner approval.">
        <ul className="ab-rules">
          {GLOBAL_RULES.map((r) => (
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
      </Card>

      <div className="ab-place">
        {list.map((p) => {
          const isEditing = editing === p.id && draft;
          return (
            <section key={p.id} className={cx('card', !p.on && 'is-off')}>
              <div className="card-head">
                <span className="row gap-2">
                  <Icon name={p.icon} />
                  <h3 className="h4">{p.name}</h3>
                  <Badge tone={p.stage === 'Launch' ? 'brand' : p.stage === 'Pilot' ? 'info' : ''}>{p.stage}</Badge>
                </span>
                <Switch id={`pl-on-${p.id}`} label={p.on ? 'Enabled' : 'Off'} checked={p.on} onChange={(e) => toggle(p, e.target.checked)} />
              </div>
              <div className="card-body">
                {isEditing ? (
                  <div className="stack gap-3">
                    {RULE_LABELS.map(([k, label]) => (
                      <Field key={k} label={label}>
                        <TextInput id={`pl-${p.id}-${k}`} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                      </Field>
                    ))}
                  </div>
                ) : (
                  <KeyValue pairs={RULE_LABELS.map(([k, label]) => [label, p.rules[k]])} />
                )}
              </div>
              <div className="card-foot">
                {isEditing ? (
                  <>
                    <span className="xs muted grow">Applies to new displays immediately</span>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => save(p)}>
                      Save rules
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="xs muted grow">{p.note}</span>
                    <Button variant="ghost" size="sm" icon="pencil" onClick={() => startEdit(p)}>
                      Edit rules
                    </Button>
                  </>
                )}
              </div>
            </section>
          );
        })}
        <section className="card is-off">
          <div className="card-head">
            <span className="row gap-2">
              <Icon name="video" />
              <h3 className="h4">Video</h3>
              <Badge>Later</Badge>
            </span>
            <Switch id="pl-on-video" label="Not available" disabled />
          </div>
          <div className="card-body">
            <p className="small sub">Playback and mute controls, designated campaign and display areas. Planned after launch.</p>
          </div>
        </section>
      </div>
    </AdminLayout>
  );
}
