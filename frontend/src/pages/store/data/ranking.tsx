import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { call, useApi, type components } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { Button, Dialog } from '@marketly/web-shared/ui';
import { LoadError, SkLines } from '@/api/cards';

// "How results are ranked": the published ranking policy (GET /api/store/search/ranking-policy) in a
// dialog. Used next to the sponsored-items note on the category and search listings. A dialog rather
// than a help article link: the policy is versioned by the search team, not written as a help article.

type RankingPolicy = components['schemas']['search.RankingPolicy'];

/** The policy changes only when staff publish a new version, so it is read once and kept. */
export function useRankingPolicy(enabled = true) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['search', 'ranking-policy'],
    queryFn: () => call(api.GET('/api/store/search/ranking-policy')),
    staleTime: 30 * 60_000,
    enabled,
  });
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/** The policy wording (paragraphs split on blank lines) and the factors of the recommended sort, with each
 * factor's weight shown as its share of the total so the numbers read the same whatever scale staff use. */
function PolicyBody({ policy }: { policy: RankingPolicy }) {
  const paragraphs = policy.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const total = policy.factors.reduce((n, f) => n + Math.max(0, f.weight), 0);
  return (
    <div className="stack gap-4">
      <div className="stack gap-2">
        {paragraphs.map((p, i) => (
          <p key={i} className="small" style={{ whiteSpace: 'pre-line' }}>
            {p}
          </p>
        ))}
      </div>
      {policy.factors.length > 0 && (
        <div className="stack gap-2">
          <h3 className="h4">What the “Recommended” sort looks at</h3>
          <ul className="stack gap-1 small">
            {policy.factors.map((f) => (
              <li key={f.key} className="row between gap-3">
                <span>{f.label}</span>
                {total > 0 && <span className="muted nowrap">{Math.round((Math.max(0, f.weight) / total) * 100)}%</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="xs muted">
        Version {policy.version} · in force since {DAY.format(new Date(policy.effectiveFrom))}. Sponsored items are paid placements, are labeled, and never change where other results rank.
      </p>
    </div>
  );
}

/**
 * A link-styled button that opens the published ranking policy. The policy is fetched when the dialog first
 * opens (not on every listing page view).
 */
export function RankingPolicyLink({ children = 'How results are ranked', className }: { children?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const policy = useRankingPolicy(open);
  return (
    <>
      {/* .btn-link without .btn: the text keeps the size of the sentence it sits in */}
      <button type="button" className={cx('btn-link', className)} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {children}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="How results are ranked"
        foot={
          <Button className="grow" onClick={() => setOpen(false)}>
            Close
          </Button>
        }
      >
        {policy.isPending ? (
          <div aria-busy="true">
            <SkLines n={5} />
          </div>
        ) : policy.isError ? (
          <LoadError error={policy.error} onRetry={() => void policy.refetch()} title="We couldn’t load the ranking policy" />
        ) : (
          <PolicyBody policy={policy.data} />
        )}
      </Dialog>
    </>
  );
}
