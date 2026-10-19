// Deals › Campaigns: the live campaign pages (GET /api/store/content/campaign-pages, ending soonest first) as a
// scrolling row of cards at the top of the Deals tab. On the phone this is the way to reach a campaign page: the
// website header links are not shown there. Nothing renders while loading, on error or when no page is live.
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { call, useApi, type components } from '@marketly/web-shared/api';
import { Icon } from '@marketly/web-shared/ui';
import { Pic } from '@/api/cards';
import { contentLinkTo } from '@/api/content';

type CampaignPageCard = components['schemas']['content.CampaignPageCard'];

const endsLabel = (iso: string) => `Ends ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}`;

export function CampaignPages() {
  const { api } = useApi();
  const q = useQuery({
    queryKey: ['content', 'campaign-pages'],
    queryFn: () => call(api.GET('/api/store/content/campaign-pages', { params: { query: { limit: 20 } } })),
  });
  const items: CampaignPageCard[] = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <section className="stack gap-3" aria-labelledby="dl-campaigns">
      <h2 className="h3" id="dl-campaigns">
        Campaigns
      </h2>
      <div className="hscroll dl-campaigns">
        {items.map((c) => (
          <Link key={c.id} className="dl-campaign" to={contentLinkTo(c.url)}>
            <Pic image={c.image} icon="megaphone" tint="2" className="dl-campaign-pic" />
            <span className="stack gap-0 min-w-0 grow">
              {c.eyebrow && <span className="xs sub truncate">{c.eyebrow}</span>}
              <span className="small strong dl-campaign-title">{c.title}</span>
              {c.endsAt && <span className="xs u-c-deal-text">{endsLabel(c.endsAt)}</span>}
            </span>
            <Icon name="chevron-right" className="ic-sm" />
          </Link>
        ))}
      </div>
    </section>
  );
}
