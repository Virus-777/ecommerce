import { useState } from 'react';
import { Link } from 'react-router';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Breadcrumbs, Button, Field, Icon, TableWrap, Textarea } from '@marketly/web-shared/ui';

// Design: pages/store/help-article.html · "Was this helpful?" feedback is interactive.

const SHIPPING_ROWS: Array<{ reason: string; who: string; whoNote: string; refunded: string }> = [
  { reason: 'Damaged in delivery', who: 'Seller', whoNote: ' · prepaid label', refunded: 'Yes' },
  { reason: 'Incorrect item sent', who: 'Seller', whoNote: ' · prepaid label', refunded: 'Yes' },
  { reason: 'Defective or not working', who: 'Seller', whoNote: ' · prepaid label', refunded: 'Yes' },
  { reason: 'Changed my mind', who: 'You', whoNote: ', unless the seller offers free returns', refunded: 'No' },
];

const RELATED = ['How refunds are calculated', 'Return windows by category', "My return label doesn't work", 'Refund-without-return: when it applies', 'Appealing a decision'];

type Feedback = '' | 'yes' | 'no' | 'sent';

export default function Article() {
  const [feedback, setFeedback] = useState<Feedback>('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');

  const sendComment = () => {
    if (!comment.trim()) {
      setError('Tell us what was missing, or close this.');
      return;
    }
    setFeedback('sent');
  };

  return (
    <StoreLayout tab="account" appbar={{ title: 'Help article', back: href('help/center') }}>
      <div className="container page">
        <Breadcrumbs items={[{ label: 'Help Center', to: href('help/center') }, { label: 'Returns', to: href('help/center') }, { label: 'Returning a marketplace seller item' }]} />
        <div className="split">
          <article className="stack gap-5">
            <div className="stack gap-2">
              <h1 className="h1">Returning an item bought from a marketplace seller</h1>
              <div className="buy-meta-strip">
                <span>
                  <Icon name="calendar" />
                  Effective Sep 1, 2026
                </span>
                <span>
                  <Icon name="history" />
                  Updated Oct 2, 2026
                </span>
                <span>
                  <Icon name="clock" />4 min read
                </span>
              </div>
            </div>
            <div className="prose">
              <p>Items sold by outside sellers on Marketly are returned to that seller, not to our warehouse. The seller's return terms are shown on the product page and in your order. Every seller must accept returns for at least 30 days after delivery, and many offer longer.</p>
              <h2>How to return an item</h2>
              <ol>
                <li>
                  Go to{' '}
                  <Link to={href('account/orders')} className="link-inline">
                    Orders
                  </Link>{' '}
                  and open the order.
                </li>
                <li>
                  Choose <b>Return items</b> next to the package, then select the item and quantity.
                </li>
                <li>Pick a reason and add photos if the item is damaged, defective or not as described.</li>
                <li>Check the summary: return deadline, where it goes, who pays shipping and your refund amount.</li>
                <li>Submit. The seller approves, asks for details or explains a rejection within 2 business days.</li>
                <li>Pack the item and drop it off with the label or instructions you receive. Track the return on your order page.</li>
              </ol>
              <h2>Who pays return shipping</h2>
            </div>
            <TableWrap label="Who pays return shipping table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Reason for return</th>
                    <th scope="col">Who pays return shipping</th>
                    <th scope="col">Original shipping refunded</th>
                  </tr>
                </thead>
                <tbody>
                  {SHIPPING_ROWS.map((r) => (
                    <tr key={r.reason}>
                      <td>{r.reason}</td>
                      <td>
                        <b>{r.who}</b>
                        {r.whoNote}
                      </td>
                      <td>{r.refunded}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <p className="xs muted">
              Official Store items always have free return shipping. Some categories have exceptions, such as opened bedding or personal care items. See the{' '}
              <Link to={href('info/policy')} className="link-inline">
                Returns policy
              </Link>
              .
            </p>
            <div className="prose">
              <h2>When Marketly steps in</h2>
              <ul>
                <li>The seller hasn't replied to your return request within 2 business days.</li>
                <li>The seller rejected the return and you don't agree with the reason.</li>
                <li>Your refund hasn't been sent within 3 business days after the seller received the item.</li>
              </ul>
              <p>
                Choose <b>Ask Marketly to help</b> on the return. Our team reviews the purchase terms, tracking, photos and messages, then makes a decision. You can appeal a decision within 14 days.
              </p>
            </div>
            {feedback === '' && (
              <div className="card pad row between">
                <span className="strong small">Was this helpful?</span>
                <span className="row gap-2">
                  <Button variant="secondary" size="sm" icon="thumbs-up" onClick={() => setFeedback('yes')}>
                    Yes
                  </Button>
                  <Button variant="secondary" size="sm" icon="thumbs-down" onClick={() => setFeedback('no')}>
                    No
                  </Button>
                </span>
              </div>
            )}
            {feedback === 'no' && (
              <div className="card pad stack gap-3">
                <span className="strong small">Sorry this didn't help. What was missing?</span>
                <Field label="Your feedback" hint="We read every comment but can't reply here. For help with an order, contact us." error={error}>
                  <Textarea
                    id="ha-fb"
                    value={comment}
                    onChange={(e) => {
                      setComment(e.target.value);
                      setError('');
                    }}
                  />
                </Field>
                <span className="row gap-2">
                  <Button size="sm" onClick={sendComment}>
                    Send feedback
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setFeedback('sent')}>
                    Skip
                  </Button>
                </span>
              </div>
            )}
            {(feedback === 'yes' || feedback === 'sent') && (
              <div className="card pad row gap-2" role="status">
                <Icon name="circle-check" className="ic-sm" />
                <span className="strong small">Thanks for your feedback.</span>
              </div>
            )}
          </article>
          <aside className="stack gap-4">
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h3 className="h4">Related articles</h3>
                </div>
              </div>
              <ul className="list pad">
                {RELATED.map((r) => (
                  <li key={r}>
                    <Link className="small" to={href('help/article')}>
                      {r}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
            <div className="card pad stack gap-2">
              <span className="strong small">Start a return</span>
              <span className="xs muted">Returns start from your order so the item is already identified.</span>
              <Button variant="secondary" size="sm" to={href('account/orders')}>
                Go to my orders
              </Button>
            </div>
            <div className="card pad stack gap-2">
              <span className="strong small">Still need help?</span>
              <span className="xs muted">Mon–Sat, 8 AM–8 PM PT</span>
              <Button variant="ghost" size="sm" icon="headset" to={href('help/contact')}>
                Contact us
              </Button>
            </div>
          </aside>
        </div>
      </div>
    </StoreLayout>
  );
}
