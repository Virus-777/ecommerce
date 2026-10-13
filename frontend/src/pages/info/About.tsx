import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, useApi } from '@marketly/web-shared/api';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, ChipRow, Chip, KeyValue } from '@marketly/web-shared/ui';
import { htmlToText, InlineHtml, RichText } from '../help/data/html';
import { ApiLink } from '../help/data/links';
import { LoadError, Loading, SkLines } from '../help/data/states';

// Design: pages/store/info-about.html
// Data: GET /api/store/content/pages/about (eyebrow, title, intro, blocks: the hero sets the heading, text
// blocks render as sections through the allowlist HTML renderer, a block titled "Contact" goes into the
// contact card); GET /api/public/settings/app-config (company name and address, service region, support
// phone and hours). The two "Official Store / Verified seller" cards are static marketing copy (no API
// source). Not shown, no API source: founding year, headquarters, warehouse, live approved-seller count,
// help/sellers/press email addresses and the labels table's "doesn't mean" column (BACKEND-REQUESTS gaps).

export default function About() {
  const { api } = useApi();
  const page = useQuery({ queryKey: ['content', 'page', 'about'], queryFn: () => call(api.GET('/api/store/content/pages/{slug}', { params: { path: { slug: 'about' } } })) });
  const config = useQuery({ queryKey: ['settings', 'app-config'], queryFn: () => call(api.GET('/api/public/settings/app-config')), staleTime: 300_000 });

  const pg = page.data;
  const blocks = pg?.blocks ?? [];
  const hero = blocks.find((b) => b.type === 'hero');
  const isContact = (b: { id: string; title?: string | null }) => b.id === 'contact' || /^contact/i.test(b.title ?? '');
  const contactBlock = blocks.find((b) => b.type === 'text' && isContact(b));
  const sections = blocks.filter((b) => b !== hero && b !== contactBlock && b.type !== 'banner' && b.type !== 'image' && b.type !== 'product_grid' && b.type !== 'product_section');
  const market = config.data?.market;
  const support = config.data?.support;
  const address = market?.companyLine?.includes('·') ? market.companyLine.split('·').slice(1).join('·').trim() : market?.companyLine;
  const heading = hero?.banner?.headline && hero.banner.headline !== pg?.title ? hero.banner.headline : (hero?.title ?? pg?.title ?? '');

  return (
    <StoreLayout appbar={{ title: 'About us', back: href('store/home') }}>
      <div className="container page">
        {page.isError ? (
          <LoadError error={page.error} retry={() => void page.refetch()} title="We couldn’t load this page" />
        ) : !pg ? (
          <section className="stack gap-3" style={{ maxWidth: 760 }}>
            <Loading label="Loading" />
            <span className="sk sk-line short" aria-hidden="true" />
            <span className="sk sk-line h-46" aria-hidden="true" />
            <SkLines n={3} />
          </section>
        ) : (
          <section className="stack gap-3" style={{ maxWidth: 760 }}>
            {pg.eyebrow && <span className="eyebrow">{pg.eyebrow}</span>}
            <h1 className="display d-xl">{heading}</h1>
            {(pg.intro || hero?.body) && <p className="lead">{pg.intro ?? htmlToText(hero?.body ?? '')}</p>}
            {hero?.banner?.primaryCta && (
              <div>
                <ApiLink url={hero.banner.primaryCta.url} className="small strong">
                  {hero.banner.primaryCta.label}
                </ApiLink>
              </div>
            )}
          </section>
        )}
        <div className="grid md2">
          <div className="card pad stack gap-3">
            <Badge tone="brand" icon="badge-check">
              Official Store
            </Badge>
            <h2 className="h3">Products we sell ourselves</h2>
            <p className="small sub">We buy the stock, set the price, pack it in our own fulfillment center and handle returns. Free returns on every Official Store item.</p>
            <Link className="small strong" to={href('store/official')}>
              Visit the Official Store
            </Link>
          </div>
          <div className="card pad stack gap-3">
            <Badge tone="info" icon="shield-check">
              Verified seller
            </Badge>
            <h2 className="h3">Products from approved sellers</h2>
            <p className="small sub">Independent businesses list their offers on our catalog and ship their own orders. They follow our seller rules, and we step in when something goes wrong.</p>
            <Link className="small strong" to={href('info/policy', 'seller-rules')}>
              Read the seller rules
            </Link>
          </div>
        </div>
        {!pg && !page.isError && <SkLines n={6} />}
        {sections.map((b) => (
          <section key={b.id} className="stack gap-4">
            {b.title && <h2 className="h2">{b.title}</h2>}
            <RichText html={b.body} tableLabel={`${b.title ?? 'About'} table`} />
            {b.items && b.items.length > 0 &&
              (b.type === 'chips' ? (
                <ChipRow>
                  {b.items.map((it) => (
                    <Chip key={it}>{it}</Chip>
                  ))}
                </ChipRow>
              ) : (
                <ul className="ul small sub stack gap-2">
                  {b.items.map((it) => (
                    <li key={it}>{it}</li>
                  ))}
                </ul>
              ))}
            {b.link && (
              <ApiLink url={b.link.url} className="small strong">
                {b.link.label}
              </ApiLink>
            )}
          </section>
        ))}
        <div className="split">
          <section className="card pad stack gap-3">
            <h2 className="h3">Company facts</h2>
            {market ? (
              <KeyValue
                pairs={[
                  ['Company', market.legalName],
                  ...(address ? ([['Address', address]] as Array<[string, string]>) : []),
                  ['Service region', `${market.serviceRegionLabel}, prices in ${market.currency}`],
                ]}
              />
            ) : config.isError ? (
              <LoadError error={config.error} retry={() => void config.refetch()} />
            ) : (
              <SkLines n={3} />
            )}
          </section>
          <section className="card pad stack gap-3">
            <h2 className="h3">Contact us</h2>
            {support ? (
              <KeyValue
                pairs={[
                  ['Customer support', support.phone],
                  ['Hours', support.hoursLabel],
                  ...(support.closedLabel ? ([['Closed', support.closedLabel.replace(/^Closed\s+/i, '')]] as Array<[string, string]>) : []),
                ]}
              />
            ) : (
              !config.isError && <SkLines n={2} />
            )}
            {contactBlock?.body && (
              <p className="xs muted">
                <InlineHtml html={contactBlock.body.replace(/^<p>|<\/p>$/g, '')} />
              </p>
            )}
            <Button variant="secondary" to={href('help/contact')}>
              Contact support
            </Button>
          </section>
        </div>
      </div>
    </StoreLayout>
  );
}
