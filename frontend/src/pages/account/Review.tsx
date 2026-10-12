import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { order, P } from '@marketly/web-shared/data/fixtures';
import { AccountLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, Checkbox, Field, FileDrop, Icon, IconButton, Img, SegmentedControl, SellerLine, TextInput, Textarea } from '@marketly/web-shared/ui';

// Design: pages/store/account-review.html (one view): product review (rating, headline, text,
// photos) and separate seller feedback, posted together.

const RATING_WORDS = ['', 'Poor', 'Fair', 'Okay', 'Good', 'Excellent'];
const MIN_TEXT = 50;
const MAX_PHOTOS = 6;

function StarRating({ name, legend, value, onChange, sm, note, hint, error }: { name: string; legend: string; value: number; onChange: (n: number) => void; sm?: boolean; note?: ReactNode; hint?: string; error?: string }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  const hintId = hint || error ? `${name}-1-${error ? 'err' : 'hint'}` : undefined;
  return (
    <fieldset className="acct-stars">
      <legend className="label">{legend}</legend>
      <div className="row gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={cx('acct-star', sm && 'sm', n <= shown && 'on')} htmlFor={`${name}-${n}`} onMouseEnter={() => setHover(n)}>
            <input
              type="radio"
              className="sr-only"
              name={name}
              id={`${name}-${n}`}
              checked={value === n}
              aria-describedby={n === 1 ? hintId : undefined}
              onChange={() => onChange(n)}
              onClick={() => value === n && hint && onChange(0)}
            />
            <Icon name="star" />
            <span className="sr-only">
              {n} star{n > 1 ? 's' : ''}
            </span>
          </label>
        ))}
        {note && <span className="small sub u-ml-6px">{note}</span>}
      </div>
      {error ? (
        <span className="error-text" id={hintId}>
          <Icon name="circle-alert" className="ic-sm" />
          {error}
        </span>
      ) : (
        hint && (
          <span className="hint" id={hintId}>
            {hint}
          </span>
        )
      )}
    </fieldset>
  );
}

interface Photo {
  id: string;
  name: string;
  src: string;
}

export default function Review() {
  const navigate = useNavigate();
  const p = P.aurora;
  const [rating, setRating] = useState(4);
  const [headline, setHeadline] = useState('Great noise cancelling, tight fit at first');
  const [text, setText] = useState(
    'The ANC blocks out bus and office noise really well and the battery lasted a full week of commuting. Clamping force was strong for the first few days but eased up. Call quality is fine indoors, weaker outside in wind.',
  );
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [showName, setShowName] = useState(true);
  const [described, setDescribed] = useState<'yes' | 'no'>('yes');
  const [dispatch, setDispatch] = useState(5);
  const [comm, setComm] = useState(0);
  const [comment, setComment] = useState('');
  const [tried, setTried] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [photoMsg, setPhotoMsg] = useState('');
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => photosRef.current.forEach((ph) => URL.revokeObjectURL(ph.src)), []);

  const errors = tried
    ? {
        rating: rating ? undefined : 'Choose a rating from 1 to 5 stars.',
        headline: headline.trim() ? undefined : 'Add a short headline.',
        text: text.trim().length >= MIN_TEXT ? undefined : `Write at least ${MIN_TEXT} characters. ${text.trim().length} so far.`,
        dispatch: dispatch ? undefined : 'Rate how fast the seller dispatched your order.',
      }
    : {};
  const nErr = Object.values(errors).filter(Boolean).length;

  const addPhotos = (files: File[]) => {
    const images = files.filter((f) => /image\/(jpeg|png)/.test(f.type));
    const room = MAX_PHOTOS - photos.length;
    const added = images.slice(0, room).map((f, i) => ({ id: `${Date.now()}-${i}`, name: f.name, src: URL.createObjectURL(f) }));
    setPhotos((ps) => [...ps, ...added]);
    setPhotoMsg(images.length > room ? `Only ${MAX_PHOTOS} photos fit. We added the first ${room}.` : images.length < files.length ? 'Some files were skipped: use JPG or PNG.' : '');
  };
  const removePhoto = (id: string) =>
    setPhotos((ps) => {
      const ph = ps.find((x) => x.id === id);
      if (ph) URL.revokeObjectURL(ph.src);
      return ps.filter((x) => x.id !== id);
    });

  const saveDraft = () => {
    setDraftSaved(true);
    announce('Draft saved');
  };
  const post = () => {
    setTried(true);
    if (!rating || !headline.trim() || text.trim().length < MIN_TEXT || !dispatch) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    navigate(href('account/reviews'));
  };

  const actions = (
    <>
      <Button variant="ghost" onClick={saveDraft}>
        Save draft
      </Button>
      <Button onClick={post}>Post review</Button>
    </>
  );

  return (
    <AccountLayout
      active="reviews"
      title="Write a review"
      actionBar={
        <>
          <Button variant="ghost" onClick={saveDraft}>
            Save draft
          </Button>
          <span className="grow" />
          <Button onClick={post}>Post review</Button>
        </>
      }
    >
      <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: order.ref, to: href('account/order') }, { label: 'Write a review' }]} />
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Write a review</h1>
          <p className="small sub">Two short parts. Each one appears in a different place.</p>
        </div>
      </div>
      {nErr > 0 && (
        <Alert tone="danger" title={`Check ${nErr} field${nErr > 1 ? 's' : ''}`}>
          Fix the highlighted fields to post your review.
        </Alert>
      )}
      {draftSaved && nErr === 0 && <Alert tone="success" title="Draft saved">Finish it any time from Reviews and feedback. Drafts aren't public.</Alert>}
      <section className="card pad row gap-4 nowrap top">
        <Img icon={p.icon} tint={p.tint} className="thumb" />
        <div className="stack gap-1">
          <Link className="small strong link-plain" to={href('store/product')}>
            {p.name}
          </Link>
          <span className="xs muted">
            Midnight black · Delivered Sep 17 · Order <span className="mono">{order.ref}</span>
          </span>
          <span className="row gap-2">
            <Badge tone="success" icon="badge-check">
              Verified Purchase
            </Badge>
            <SellerLine seller="official" badge />
          </span>
        </div>
      </section>
      <div className="acct-split">
        <div className="stack gap-4">
          <Card title="1. Product review" sub="About the headphones themselves: sound, comfort, battery. Shown on the product page for every seller.">
            <StarRating name="rv-prod" legend="Overall rating" value={rating} onChange={setRating} note={RATING_WORDS[rating] || undefined} error={errors.rating} />
            <Field label="Headline" error={errors.headline}>
              <TextInput id="rv-head" value={headline} error={!!errors.headline} maxLength={120} onChange={(e) => (setHeadline(e.target.value), setDraftSaved(false))} />
            </Field>
            <Field label="Your review" hint={`At least ${MIN_TEXT} characters. ${text.trim().length} so far.`} error={errors.text}>
              <Textarea id="rv-text" value={text} className={cx(errors.text && 'is-error')} onChange={(e) => (setText(e.target.value), setDraftSaved(false))} />
            </Field>
            <div className="field">
              <span className="label">
                Photos <span className="opt">(optional)</span>
              </span>
              {photos.length > 0 && (
                <div className="row gap-2">
                  {photos.map((ph) => (
                    <span key={ph.id} className="stack gap-1 u-items-center">
                      <Img icon="image" tint="2" className="thumb" src={ph.src} alt={ph.name} />
                      <IconButton icon="x" size="sm" label={`Remove ${ph.name}`} onClick={() => removePhoto(ph.id)} />
                    </span>
                  ))}
                </div>
              )}
              {photos.length < MAX_PHOTOS && <FileDrop title="Add photos of the product" hint={`Up to ${MAX_PHOTOS} photos, JPG or PNG${photos.length ? ` · ${MAX_PHOTOS - photos.length} left` : ''}`} onFiles={addPhotos} />}
              {photoMsg && <span className="hint">{photoMsg}</span>}
            </div>
            <Checkbox id="rv-name" label="Show my name as Jordan L." checked={showName} onChange={(e) => setShowName(e.target.checked)} />
          </Card>
          <Card title="2. Seller feedback for Marketly Official" titleAs="h3" sub="About buying from this seller: accuracy, dispatch and communication. Shown on the seller profile, not the product page.">
            <div className="field">
              <span className="label" id="rv-desc-l">
                Was the item as described?
              </span>
              <SegmentedControl<'yes' | 'no'>
                label="Was the item as described?"
                active={described}
                onChange={setDescribed}
                items={[
                  { value: 'yes', label: 'Yes' },
                  { value: 'no', label: 'No' },
                ]}
              />
            </div>
            <StarRating name="rv-ship" legend="Dispatch speed" sm value={dispatch} onChange={setDispatch} note="Arrived Sep 17, 1 day early" error={errors.dispatch} />
            <StarRating name="rv-comm" legend="Communication" sm value={comm} onChange={setComm} hint="Leave blank if you didn't contact the seller." />
            <Field label="Comment for the seller" optional>
              <Textarea id="rv-seller" placeholder="For example: well packed, arrived early." value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
          </Card>
          <div className="row between only-desktop">{actions}</div>
        </div>
        <aside>
          <Card title="Product review or seller feedback?" titleAs="h3">
            <div className="stack gap-3 small sub">
              <p>
                <span className="strong u-c-text">Product review</span>: the item. If it broke or sounds bad, say it here.
              </p>
              <p>
                <span className="strong u-c-text">Seller feedback</span>: the purchase. Late dispatch, poor packing or slow replies go here.
              </p>
              <p>
                Need a refund or repair instead?{' '}
                <Link to={href('help/order-problem')} className="link-inline">
                  Report a problem
                </Link>{' '}
                or{' '}
                <Link to={href('account/return-new')} className="link-inline">
                  return the item
                </Link>
                .
              </p>
            </div>
          </Card>
          <Card title="Review guidelines" titleAs="h3">
            <ul className="ul small sub stack gap-1">
              <li>Describe your own experience with this item.</li>
              <li>No personal details, links, prices or order numbers.</li>
              <li>No offers of payment or free items for reviews.</li>
              <li>We don't remove fair negative reviews.</li>
            </ul>
            <Link className="small strong" to={href('help/article')}>
              Full review rules
            </Link>
          </Card>
          <Alert tone="info" title="You can edit later">
            <span className="strong">Verified Purchase</span> means this review is linked to your recorded order. You can edit or delete it any time from{' '}
            <Link to={href('account/reviews')} className="link-inline">
              Reviews and feedback
            </Link>
            , and we'll tell you if moderation changes it.
          </Alert>
        </aside>
      </div>
    </AccountLayout>
  );
}
