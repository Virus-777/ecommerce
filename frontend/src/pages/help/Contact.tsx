import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { href } from '@/routes/href';
import { Breadcrumbs, Button, Field, FileDrop, Icon, IconButton, KeyValue, OptionCard, Select, Textarea, type IconName } from '@/ui';

// Design: pages/store/help-contact.html

const TOPICS = ['Delivery: late or missing package', 'Damaged or wrong item', 'Returns and refunds', 'Payment or charge question', 'Cancel an item', 'Account and sign-in', 'Something else'];

interface OrderOpt {
  ref: string;
  date: string;
  items: string[];
}

const ORDERS: OrderOpt[] = [
  { ref: 'MK-261006-90127', date: 'Oct 6, 2026', items: ['Tidewell Insulated Bottle 750 ml (Trailhead Outfitters)', 'Corvo Grip Yoga Mat 6 mm (Trailhead Outfitters)'] },
  {
    ref: 'MK-260914-48213',
    date: 'Sep 14, 2026',
    items: ['Mosswood Washed Linen Duvet Cover, Queen (Casa Verde Home)', 'Kestrel 1 TB Portable SSD ×2 (Pixel & Port)', 'Halden Aurora ANC Headphones (Marketly Official)', 'Mosswood Ceramic Pour-over Set (Marketly Official)'],
  },
  { ref: 'MK-260830-11764', date: 'Aug 30, 2026', items: ['Pellar Pre-seasoned Cast Iron Skillet 26 cm (Marketly Official)'] },
  { ref: 'MK-260818-07352', date: 'Aug 18, 2026', items: ['Trailhead Ridge 40 L Hiking Backpack (Trailhead Outfitters)'] },
  { ref: 'MK-260811-03309', date: 'Aug 11, 2026', items: ['Corvo Swift Trail Running Shoes (Trailhead Outfitters)'] },
];
const WHOLE = 'Whole order';
/** Items that already have an open case: the form points the shopper there. */
const OPEN_CASES: Record<string, string> = { 'Mosswood Washed Linen Duvet Cover, Queen (Casa Verde Home)': 'CS-104882' };

type Channel = 'email' | 'chat' | 'phone';

export default function Contact() {
  const { customer } = useSession();
  const navigate = useNavigate();
  const [topic, setTopic] = useState(TOPICS[0]);
  const [orderRef, setOrderRef] = useState(ORDERS[1].ref);
  const order = ORDERS.find((o) => o.ref === orderRef) ?? ORDERS[0];
  const [item, setItem] = useState(order.items[0]);
  const [msg, setMsg] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState('');
  const [channel, setChannel] = useState<Channel>('email');
  const [attempted, setAttempted] = useState(false);

  const msgError = attempted && msg.trim().length < 10 ? 'Tell us what happened in a sentence or two.' : undefined;
  const openCase = OPEN_CASES[item];

  const CHANNELS: Array<{ id: Channel; name: string; time: string; body: string; icon: IconName }> = [
    { id: 'email', name: 'Email', time: 'Within 1 business day', body: `Reply goes to ${customer.email} and appears in Support cases.`, icon: 'mail' },
    { id: 'chat', name: 'Chat', time: 'About 2 minutes', body: 'Open now until 8 PM PT. Your message starts the chat.', icon: 'message-circle' },
    { id: 'phone', name: 'Phone call back', time: 'Within 4 business hours', body: `We call ${customer.phone} between 8 AM and 8 PM PT.`, icon: 'phone' },
  ];

  const addFiles = (picked: File[]) => {
    const ok = picked.filter((f) => /\.(jpe?g|png|pdf)$/i.test(f.name) && f.size <= 10 * 1024 * 1024);
    const next = [...files, ...ok].slice(0, 5);
    setFileError(ok.length < picked.length ? 'Some files were skipped: use JPG, PNG or PDF up to 10 MB.' : files.length + ok.length > 5 ? 'You can attach up to 5 files.' : '');
    setFiles(next);
  };

  const send = () => {
    setAttempted(true);
    if (msg.trim().length < 10) return;
    navigate(href('help/cases'));
  };

  return (
    <StoreLayout tab="account" appbar={{ title: 'Contact us', back: href('help/center') }}>
      <div className="container page">
        <Breadcrumbs items={[{ label: 'Help Center', to: href('help/center') }, { label: 'Contact us' }]} />
        <div className="split">
          <div className="stack gap-4">
            <h1 className="h1">Contact Marketly support</h1>
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h2 className="h4">What do you need help with?</h2>
                </div>
              </div>
              <div className="card-body">
                <Field label="Topic">
                  <Select id="ct-topic" options={TOPICS} value={topic} onChange={(e) => setTopic(e.target.value)} />
                </Field>
                <div className="grid md2">
                  <Field label="Order">
                    <Select
                      id="ct-order"
                      options={ORDERS.map((o) => ({ value: o.ref, label: `${o.ref} · ${o.date}` }))}
                      value={orderRef}
                      onChange={(e) => {
                        const next = ORDERS.find((o) => o.ref === e.target.value) ?? ORDERS[0];
                        setOrderRef(next.ref);
                        setItem(next.items[0]);
                      }}
                    />
                  </Field>
                  <Field label="Item">
                    <Select id="ct-item" options={[...order.items, WHOLE]} value={item} onChange={(e) => setItem(e.target.value)} />
                  </Field>
                </div>
                {openCase && (
                  <div className="buy-note t-info">
                    <Icon name="info" />
                    <span>
                      This item already has an open case,{' '}
                      <Link to={href('help/case')} className="link-inline">
                        {openCase}
                      </Link>
                      . Adding a message there keeps everything in one place.
                    </span>
                  </div>
                )}
                <Field label="Message" hint="Don't include full card numbers or passwords." error={msgError}>
                  <Textarea id="ct-msg" placeholder="Tell us what happened and what you would like us to do." value={msg} onChange={(e) => setMsg(e.target.value)} />
                </Field>
                <div className="field">
                  <span className="label">
                    Attachments <span className="opt">(optional)</span>
                  </span>
                  <FileDrop title="Add photos or screenshots" hint="JPG, PNG or PDF, up to 10 MB each, 5 files max" accept="image/jpeg,image/png,application/pdf" onFiles={addFiles} />
                  {fileError && (
                    <span className="error-text">
                      <Icon name="circle-alert" className="ic-sm" />
                      {fileError}
                    </span>
                  )}
                  {files.length > 0 && (
                    <ul className="list">
                      {files.map((f, i) => (
                        <li key={`${f.name}${i}`} className="row gap-2">
                          <Icon name="paperclip" className="ic-sm" />
                          <span className="small grow">{f.name}</span>
                          <IconButton icon="x" size="sm" label={`Remove ${f.name}`} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h3 className="h4">How should we reply?</h3>
                </div>
              </div>
              <div className="card-body">
                <div className="buy-opts">
                  {CHANNELS.map((c) => (
                    <OptionCard
                      key={c.id}
                      id={`ct-ch-${c.id}`}
                      name="ct-ch"
                      checked={channel === c.id}
                      onChange={() => setChannel(c.id)}
                      title={
                        <span className="row between">
                          <span className="small strong">{c.name}</span>
                          <span className="xs strong">{c.time}</span>
                        </span>
                      }
                      body={c.body}
                      right={<Icon name={c.icon} />}
                    />
                  ))}
                </div>
              </div>
              <div className="card-foot">
                <Button variant="ghost" to={href('help/center')}>
                  Cancel
                </Button>
                <Button icon="send" onClick={send}>
                  Send message
                </Button>
              </div>
            </section>
          </div>
          <aside className="stack gap-4">
            <div className="card pad stack gap-2">
              <span className="strong small">Support hours</span>
              <KeyValue
                pairs={[
                  ['Chat', 'Mon–Sat, 8 AM–8 PM PT'],
                  ['Phone', '1-800-555-0136, Mon–Sat 8 AM–8 PM PT'],
                  ['Messages', 'Any time, reply in 1 business day'],
                ]}
              />
            </div>
            <div className="card pad stack gap-2">
              <span className="strong small">Item from a marketplace seller?</span>
              <span className="xs muted">
                The seller handles questions about their items first. You can{' '}
                <Link to={href('account/messages')} className="link-inline">
                  message the seller
                </Link>{' '}
                from your order. We step in if they don't reply within 2 business days.
              </span>
            </div>
          </aside>
        </div>
      </div>
    </StoreLayout>
  );
}
