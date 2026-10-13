import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi, useUploads } from '@marketly/web-shared/api';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Field, FileDrop, Icon, KeyValue, OptionCard, Select, Textarea, TextInput, type IconName } from '@marketly/web-shared/ui';
import { dateLong } from './data/format';
import { LoadError, SkLines } from './data/states';
import { UploadList } from './data/UploadList';

// Design: pages/store/help-contact.html
// Data: GET /api/store/support/contact-options (topics = case categories, reply channels, hours, phone);
// signed in: GET /api/store/orders/orders (order picker), GET /api/store/support/orders/{id}/problem-context
// (items + open cases of the chosen order). Send: attachments upload with purpose case_evidence, then
// POST /api/store/support/cases (Idempotency-Key) { kind: customer_help, category, orderId?, orderItemIds?,
// message, mediaIds, replyChannel, callbackPhone? } → the new case. ?order=<ref> and ?channel=<kind> preselect.
// Chat is hidden as a reply channel: there is no live chat (BACKEND-REQUESTS G7).

type Channel = 'email' | 'phone';
const NO_ORDER = '';
const WHOLE = '';
const CHANNEL_ICON: Record<Channel, IconName> = { email: 'mail', phone: 'phone' };

export default function Contact() {
  const { api } = useApi();
  const { customer, signedIn, ready } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const options = useQuery({ queryKey: ['support', 'contact-options'], queryFn: () => call(api.GET('/api/store/support/contact-options')), staleTime: 300_000 });
  const orders = useQuery({
    queryKey: ['orders', 'list', { limit: 20 }],
    queryFn: () => call(api.GET('/api/store/orders/orders', { params: { query: { limit: 20, page: 1 } } })),
    enabled: signedIn,
  });

  const topics = (options.data?.topics ?? []).filter((t) => t.active !== false);
  const [topic, setTopic] = useState('');
  const topicKey = topic || topics[0]?.key || '';
  const [orderId, setOrderId] = useState<string | null>(null);
  const preRef = params.get('order');
  const preOrder = preRef ? orders.data?.items.find((o) => o.ref === preRef)?.id : undefined;
  const currentOrder = orderId ?? preOrder ?? NO_ORDER;
  const [itemId, setItemId] = useState(WHOLE);
  const context = useQuery({
    queryKey: ['support', 'problem-context', currentOrder],
    queryFn: () => call(api.GET('/api/store/support/orders/{orderId}/problem-context', { params: { path: { orderId: currentOrder } } })),
    enabled: Boolean(currentOrder),
  });
  const items = (context.data?.packages ?? []).flatMap((p) => p.items);
  const openCase = context.data?.openCases.find((c) => (itemId ? c.orderItemIds.includes(itemId) : true));

  const [msg, setMsg] = useState('');
  const files = useUploads('case_evidence', { max: 5, accept: /\.(jpe?g|png|pdf)$|^image\/(jpeg|png)$|^application\/pdf$/i });
  const pre = params.get('channel');
  const [channel, setChannel] = useState<Channel>(pre === 'phone' ? 'phone' : 'email');
  const [callbackPhone, setCallbackPhone] = useState('');
  const [attempted, setAttempted] = useState(false);
  const idem = useRef(newIdempotencyKey());

  useEffect(() => setItemId(WHOLE), [currentOrder]);

  const channels = (options.data?.channels ?? []).filter((c): c is typeof c & { kind: Channel } => c.kind === 'email' || c.kind === 'phone');
  const phone = customer?.phone ?? '';
  const msgError = attempted && msg.trim().length < 10 ? 'Tell us what happened in a sentence or two.' : undefined;
  const phoneError = attempted && channel === 'phone' && !phone && callbackPhone.replace(/\D/g, '').length < 10 ? 'Enter a 10-digit phone number for the call back.' : undefined;

  const create = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/store/support/cases', {
          params: { header: { 'Idempotency-Key': idem.current } },
          body: {
            kind: 'customer_help',
            category: topicKey,
            orderId: currentOrder || undefined,
            orderItemIds: currentOrder && itemId ? [itemId] : undefined,
            message: msg.trim(),
            mediaIds: files.assetIds.length ? files.assetIds : undefined,
            replyChannel: channel,
            callbackPhone: channel === 'phone' ? phone || callbackPhone.trim() : undefined,
          },
        }),
      ),
    onSuccess: (c) => {
      idem.current = newIdempotencyKey();
      navigate(href('help/case', '', { ref: c.ref }));
    },
    onError: (e) => {
      // A refused request frees the key; a new attempt with changed input needs a new one.
      if (e instanceof ApiError && e.status < 500) idem.current = newIdempotencyKey();
    },
  });
  const duplicate = create.error instanceof ApiError && create.error.code === 'DUPLICATE_CASE' ? String(create.error.details.ref ?? '') : '';
  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};

  const send = () => {
    setAttempted(true);
    if (msg.trim().length < 10 || files.uploading || files.failed || !topicKey) return;
    if (channel === 'phone' && !phone && callbackPhone.replace(/\D/g, '').length < 10) return;
    create.mutate();
  };

  const signInTo = href('auth/sign-in', '', undefined, { next: location.pathname + location.search });

  return (
    <StoreLayout tab="account" appbar={{ title: 'Contact us', back: href('help/center') }}>
      <div className="container page">
        <Breadcrumbs items={[{ label: 'Help Center', to: href('help/center') }, { label: 'Contact us' }]} />
        <div className="split">
          <div className="stack gap-4">
            <h1 className="h1">Contact Marketly support</h1>
            {ready && !signedIn && (
              <Alert tone="info" title="Sign in to contact us about an order">
                We reply in your Support cases and by email, so we need to know who you are.{' '}
                <Link to={signInTo} className="link-inline">
                  Sign in
                </Link>{' '}
                or{' '}
                <Link to={href('auth/guest-orders')} className="link-inline">
                  look up a guest order
                </Link>
                .
              </Alert>
            )}
            {options.isError && <LoadError error={options.error} retry={() => void options.refetch()} />}
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h2 className="h4">What do you need help with?</h2>
                </div>
              </div>
              <div className="card-body">
                {options.isPending ? (
                  <SkLines n={3} />
                ) : (
                  <Field label="Topic" error={fieldErrors.category}>
                    <Select id="ct-topic" options={topics.map((t) => ({ value: t.key, label: t.label }))} value={topicKey} onChange={(e) => setTopic(e.target.value)} />
                  </Field>
                )}
                {signedIn && (
                  <div className="grid md2">
                    <Field label="Order" optional>
                      <Select
                        id="ct-order"
                        options={[{ value: NO_ORDER, label: orders.isPending ? 'Loading your orders…' : 'Not about an order' }, ...(orders.data?.items ?? []).map((o) => ({ value: o.id, label: `${o.ref} · ${dateLong(o.placedAt)}` }))]}
                        value={currentOrder}
                        onChange={(e) => setOrderId(e.target.value)}
                      />
                    </Field>
                    <Field label="Item">
                      <Select
                        id="ct-item"
                        disabled={!currentOrder || context.isPending}
                        options={[...items.map((it) => ({ value: it.orderItemId, label: `${it.title}${it.quantity > 1 ? ` ×${it.quantity}` : ''} (${it.sellerName})` })), { value: WHOLE, label: 'Whole order' }]}
                        value={itemId}
                        onChange={(e) => setItemId(e.target.value)}
                      />
                    </Field>
                  </div>
                )}
                {openCase && (
                  <div className="buy-note t-info">
                    <Icon name="info" />
                    <span>
                      {itemId ? 'This item' : 'This order'} already has an open case,{' '}
                      <Link to={href('help/case', '', { ref: openCase.ref })} className="link-inline">
                        {openCase.ref}
                      </Link>
                      . Adding a message there keeps everything in one place.
                    </span>
                  </div>
                )}
                <Field label="Message" hint="Don't include full card numbers or passwords." error={msgError ?? fieldErrors.message}>
                  <Textarea id="ct-msg" placeholder="Tell us what happened and what you would like us to do." value={msg} maxLength={5000} onChange={(e) => setMsg(e.target.value)} />
                </Field>
                <div className="field">
                  <span className="label">
                    Attachments <span className="opt">(optional)</span>
                  </span>
                  <FileDrop title="Add photos or screenshots" hint="JPG, PNG or PDF, up to 10 MB each, 5 files max" accept="image/jpeg,image/png,application/pdf" onFiles={files.add} />
                  <UploadList uploads={files} />
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
                  {channels.map((c) => (
                    <OptionCard
                      key={c.kind}
                      id={`ct-ch-${c.kind}`}
                      name="ct-ch"
                      checked={channel === c.kind}
                      onChange={() => setChannel(c.kind)}
                      title={
                        <span className="row between">
                          <span className="small strong">{c.kind === 'phone' ? 'Phone call back' : 'Email'}</span>
                          <span className="xs strong">{c.expectedResponse}</span>
                        </span>
                      }
                      body={
                        c.kind === 'email'
                          ? `Reply goes to ${customer?.email ?? 'your account email'} and appears in Support cases.`
                          : `We call ${phone || 'you'} ${c.hours ? `(${c.hours})` : ''}.`.replace(' .', '.')
                      }
                      right={<Icon name={CHANNEL_ICON[c.kind]} />}
                    />
                  ))}
                </div>
                {channel === 'phone' && !phone && (
                  <Field label="Phone number for the call back" error={phoneError ?? fieldErrors.callbackPhone}>
                    <TextInput id="ct-phone" type="tel" autoComplete="tel" value={callbackPhone} error={!!phoneError} onChange={(e) => setCallbackPhone(e.target.value)} />
                  </Field>
                )}
                {duplicate ? (
                  <Alert tone="info" title={`You already have an open case: ${duplicate}`}>
                    <Link to={href('help/case', '', { ref: duplicate })} className="link-inline">
                      Add your message there
                    </Link>{' '}
                    so everything stays in one place.
                  </Alert>
                ) : (
                  create.isError && (
                    <span className="error-text">
                      <Icon name="circle-alert" className="ic-sm" />
                      {errorMessage(create.error)}
                    </span>
                  )
                )}
                {attempted && files.uploading && <span className="xs muted">Wait for the attachments to finish uploading.</span>}
                {attempted && files.failed && (
                  <span className="error-text">
                    <Icon name="circle-alert" className="ic-sm" />
                    Remove the attachments that failed, or add them again.
                  </span>
                )}
              </div>
              <div className="card-foot">
                <Button variant="ghost" to={href('help/center')}>
                  Cancel
                </Button>
                <Button icon="send" onClick={send} disabled={!signedIn || create.isPending || options.isPending}>
                  {create.isPending ? 'Sending…' : 'Send message'}
                </Button>
              </div>
            </section>
          </div>
          <aside className="stack gap-4">
            <div className="card pad stack gap-2">
              <span className="strong small">Support hours</span>
              {options.data ? (
                <KeyValue
                  pairs={(options.data.channels ?? [])
                    .filter((c) => c.kind !== 'chat')
                    .map((c): [string, string] => [c.kind === 'phone' ? 'Phone' : c.kind === 'email' ? 'Email' : 'Messages', c.kind === 'phone' ? `${options.data!.phone}, ${c.hours}` : `${c.hours}, reply ${c.expectedResponse.replace(/^W/, 'w')}`])}
                />
              ) : (
                <SkLines n={3} />
              )}
            </div>
            <div className="card pad stack gap-2">
              <span className="strong small">Item from a marketplace seller?</span>
              <span className="xs muted">
                {(options.data?.sellerFirstNote ?? 'The seller handles questions about their items first').replace(/\.$/, '')}. You can{' '}
                <Link to={href('account/messages')} className="link-inline">
                  message the seller
                </Link>{' '}
                from your order.
              </span>
            </div>
          </aside>
        </div>
      </div>
    </StoreLayout>
  );
}
