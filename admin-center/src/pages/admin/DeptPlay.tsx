import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { useDebounced, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, CopyButton, Dialog, Drawer, EmptyState, Field, IconButton, Img, PageHeader, Pager, SearchInput, SegmentedControl, Select, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, dateTime, LoadError, SkeletonLines } from '@/app/parts';
import { codeOf, DeptPage, fieldErrorsOf, PAGE_SIZE, PERIODS, PictureField, plural, SHOWN_STATUS, slugify, totalPagesOf, useCouponCampaigns, type Game, type GameInput, type GameKey, type MediaRef, type Period, type PrizeAward } from './data/departments';

// Admin › Departments › Play center (designed in React from the Marketly Departments canvas). Games are played
// outside the app (2026-10-22 decision): a game partner's server posts scores with the game's server key, rankings are
// worked out from them, and each prize week's winners get a coupon of the tier's promotions campaign. A game without
// posted scores keeps the table staff enter on the Rankings tab.
// Tabs: Games | Rankings | Server keys | Prize coupons | Player IDs.
// API: /api/admin/departments/play/{games, games/{id}/rankings/{period}, games/{id}/keys, games/{id}/awards, players}.

type Tab = '' | 'rankings' | 'keys' | 'awards' | 'players';
type Notify = (title: string, tone?: 'success' | 'danger') => void;
const MAX_ROWS = 100;
const MAX_ACTIVE_KEYS = 2;
const PRIZE_NOTE_MAX = 200;
const intIn = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;
const ratingText = (g: Game) => (g.rating != null && g.ratingCount ? `★ ${g.rating.toFixed(1)} (${num(g.ratingCount)})` : 'No reviews');

export default function DeptPlay() {
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('departments.view');
  const canEdit = can('departments.play.manage');
  const canKeys = can('departments.play.keys');
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };
  const games = useQuery({ queryKey: ['departments', 'play', 'games'], enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/play/games')) });
  const activeKeys = games.data?.reduce((s, g) => s + g.activeKeyCount, 0);

  return (
    <DeptPage active="dept-play" title="Play center" canView={canView}>
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Play center' }]}
        title="Play center"
        sub={canEdit ? 'Games, rankings, game partners’ server keys and prize coupons of the app’s Play center · the carousel at the top is the play_top ad placement' : 'View only: editing needs the Play center permission'}
        actions={
          canEdit &&
          !view && (
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              Add game
            </Button>
          )
        }
      />
      <Tabs
        items={[
          { value: '', label: 'Games', count: games.data?.length },
          { value: 'rankings', label: 'Rankings' },
          { value: 'keys', label: 'Server keys', count: activeKeys || undefined },
          { value: 'awards', label: 'Prize coupons' },
          { value: 'players', label: 'Player IDs' },
        ]}
        active={view}
        onChange={(v) => {
          setNotice(null);
          setView(v as Tab);
        }}
        label="Play center"
      />
      {(!view || view === 'rankings') && (
        <Alert tone="info" title="Games are played outside the app.">
          A game’s own server posts each customer’s scores with its server key, and the rankings are worked out from them. A game without posted scores shows the table staff keep on the Rankings tab. The app’s Play button still says Coming soon.
        </Alert>
      )}
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      {view === 'players' ? (
        <PlayersTab />
      ) : games.isError ? (
        <LoadError error={games.error} onRetry={() => void games.refetch()} />
      ) : games.isPending ? (
        <section className="card">
          <div className="card-body">
            <SkeletonLines rows={5} />
          </div>
        </section>
      ) : view === 'rankings' ? (
        <RankingsTab notify={notify} canEdit={canEdit} games={games.data} />
      ) : view === 'keys' ? (
        <KeysTab notify={notify} canKeys={canKeys} games={games.data} />
      ) : view === 'awards' ? (
        <AwardsTab games={games.data} />
      ) : (
        <GamesTab notify={notify} canEdit={canEdit} games={games.data} adding={adding} setAdding={setAdding} />
      )}
    </DeptPage>
  );
}

/** Games in staff order, for the game pickers */
const ordered = (games: Game[]) => [...games].sort((a, b) => a.position - b.position);

function GamePicker({ id, games, value, onChange }: { id: string; games: Game[]; value: string; onChange: (id: string) => void }) {
  return (
    <select className="select" id={id} aria-label="Game" value={value} onChange={(e) => onChange(e.target.value)}>
      {ordered(games).map((g) => (
        <option key={g.id} value={g.id}>
          {g.title}
          {g.status === 'hidden' ? ' (hidden)' : ''}
        </option>
      ))}
    </select>
  );
}

function NoGames({ icon, what }: { icon: 'trophy' | 'key-round' | 'ticket-percent'; what: string }) {
  return (
    <section className="card">
      <div className="card-body">
        <EmptyState icon={icon} title="Add a game first">
          {what} belong to a game.
        </EmptyState>
      </div>
    </section>
  );
}

/* ---------------- Games ---------------- */

type PrizeDraft = { from: string; to: string; reward: string; campaignId: string; campaignName: string | null; campaignActive: boolean | null };
type GameDraft = { id: string; title: string; slug: string; genre: string; icon: MediaRef | null; cover: MediaRef | null; playersLabel: string; featured: boolean; description: string; howToPlay: string[]; prizes: PrizeDraft[]; prizeNote: string; status: Game['status']; position: string };
/** Ranks of a tier saved before fromRank and toRank existed (#1, #4–10) */
const ranksOf = (label: string): [string, string] => {
  const m = /(\d+)(?:\s*[–—-]\s*#?(\d+))?/.exec(label);
  return m ? [m[1], m[2] ?? m[1]] : ['', ''];
};
const prizeDraftOf = (p: Game['prizes'][number]): PrizeDraft => {
  const [from, to] = p.fromRank != null ? [String(p.fromRank), String(p.toRank ?? p.fromRank)] : ranksOf(p.ranks);
  return { from, to, reward: p.reward, campaignId: p.campaignId ?? '', campaignName: p.campaignName ?? null, campaignActive: p.campaignActive };
};
const draftOf = (g?: Game): GameDraft => ({
  id: g?.id ?? '',
  title: g?.title ?? '',
  slug: g?.slug ?? '',
  genre: g?.genre ?? '',
  icon: g?.icon ?? null,
  cover: g?.cover ?? null,
  playersLabel: g?.playersLabel ?? '',
  featured: g?.featured ?? false,
  description: g?.description ?? '',
  howToPlay: g?.howToPlay?.length ? [...g.howToPlay] : [''],
  prizes: g?.prizes?.map(prizeDraftOf) ?? [],
  prizeNote: g?.prizeNote ?? '',
  status: g?.status ?? 'hidden',
  position: g ? String(g.position) : '',
});
const emptyPrize = (after?: PrizeDraft): PrizeDraft => {
  const next = after && intIn(after.to || after.from, 1, 99) ? String(Number(after.to || after.from) + 1) : after ? '' : '1';
  return { from: next, to: next, reward: '', campaignId: '', campaignName: null, campaignActive: null };
};
const isBlankPrize = (p: PrizeDraft) => !p.reward.trim() && !p.campaignId && !p.from.trim() && !p.to.trim();

function prizeProblem(prizes: PrizeDraft[]) {
  const used = prizes.filter((p) => !isBlankPrize(p));
  for (const [i, p] of used.entries()) {
    const n = `Prize ${i + 1}`;
    if (!p.reward.trim()) return `${n}: enter the reward, e.g. $20 coupon.`;
    if (!intIn(p.from, 1, 100)) return `${n}: the first rank is a whole number from 1 to 100.`;
    if (p.to.trim() && (!intIn(p.to, 1, 100) || Number(p.to) < Number(p.from))) return `${n}: the last rank is a whole number from the first rank to 100.`;
  }
  const spans = used.map((p) => [Number(p.from), Number(p.to.trim() || p.from)]).sort((a, b) => a[0] - b[0]);
  if (spans.some((s, i) => i > 0 && s[0] <= spans[i - 1][1])) return 'Prize ranks overlap: each rank can win only one prize.';
  return '';
}
const rankLabel = (p: PrizeDraft) => (p.to.trim() && p.to.trim() !== p.from.trim() ? `#${p.from.trim()}–${p.to.trim()}` : `#${p.from.trim() || '…'}`);

function GamesTab({ notify, canEdit, games, adding, setAdding }: { notify: Notify; canEdit: boolean; games: Game[]; adding: boolean; setAdding: (v: boolean) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<GameDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const rows = ordered(games);
  const genres = [...new Set(games.map((g) => g.genre).filter(Boolean))];

  const editing = draft ?? (adding ? draftOf() : null);
  const campaigns = useCouponCampaigns(canEdit && !!editing);
  const options = campaigns.data ?? [];
  const setD = (patch: Partial<GameDraft>) => editing && setDraft({ ...editing, ...patch });
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const problems = (d: GameDraft) => ({
    title: d.title.trim() ? '' : 'Enter the game’s name.',
    genre: d.genre.trim() ? '' : 'Enter the genre, e.g. Puzzle.',
    prizes: prizeProblem(d.prizes),
    prizeNote: d.prizeNote.trim().length > PRIZE_NOTE_MAX ? `Keep the prize note to ${PRIZE_NOTE_MAX} characters.` : '',
  });
  const errs = tried && editing ? problems(editing) : null;

  const save = useMutation({
    mutationFn: (d: GameDraft) => {
      const body: GameInput = {
        title: d.title.trim(),
        slug: d.slug.trim() || null,
        genre: d.genre.trim(),
        icon: d.icon,
        cover: d.cover,
        playersLabel: d.playersLabel.trim() || null,
        featured: d.featured,
        description: d.description.trim() || null,
        howToPlay: d.howToPlay.map((s) => s.trim()).filter(Boolean),
        prizes: d.prizes
          .filter((p) => !isBlankPrize(p))
          .map((p) => ({ reward: p.reward.trim(), fromRank: Number(p.from), toRank: Number(p.to.trim() || p.from), campaignId: p.campaignId || null })),
        prizeNote: d.prizeNote.trim() || null,
        status: d.status,
        position: d.position.trim() ? Number(d.position) : null,
      };
      return d.id ? call(api.PATCH('/api/admin/departments/play/games/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/departments/play/games', { body }));
    },
    onSuccess: (g, d) => {
      void qc.invalidateQueries({ queryKey: ['departments', 'play'] });
      notify(d.id ? `${g.title} saved` : `${g.title} added${g.status === 'hidden' ? ' as hidden: publish it when it is ready' : ''}`);
      close();
    },
    onError: (e) => setError(Object.values(fieldErrorsOf(e)).join(' ') || errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (d: GameDraft) => call(api.DELETE('/api/admin/departments/play/games/{id}', { params: { path: { id: d.id } } })),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: ['departments', 'play'] });
      notify(`${d.title} deleted with its ranking tables`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    if (!editing) return;
    setTried(true);
    if (Object.values(problems(editing)).some(Boolean)) return;
    save.mutate(editing);
  };
  const setStep = (i: number, v: string) => editing && setD({ howToPlay: editing.howToPlay.map((s, k) => (k === i ? v : s)) });
  const moveStep = (i: number, dir: -1 | 1) => {
    if (!editing) return;
    const j = i + dir;
    if (j < 0 || j >= editing.howToPlay.length) return;
    const next = [...editing.howToPlay];
    [next[i], next[j]] = [next[j], next[i]];
    setD({ howToPlay: next });
  };
  const setPrize = (i: number, patch: Partial<PrizeDraft>) => editing && setD({ prizes: editing.prizes.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const pickCampaign = (i: number, id: string) => {
    const c = options.find((x) => x.id === id);
    setPrize(i, { campaignId: id, campaignName: c?.name ?? null, campaignActive: c ? c.status === 'live' || c.status === 'scheduled' : null });
  };

  return (
    <>
      <section className="card">
        <TableWrap label="Games table">
          <table className="table">
            <thead>
              <tr>
                <th className="r" scope="col">
                  Order
                </th>
                <th scope="col">Game</th>
                <th scope="col">Genre</th>
                <th scope="col">Prizes</th>
                <th scope="col">Rankings</th>
                <th scope="col">Rating</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const idle = g.prizes.filter((p) => p.campaignId && !p.campaignActive).length;
                const unlinked = g.prizes.filter((p) => !p.campaignId).length;
                return (
                  <tr key={g.id}>
                    <td className="r small">{g.position}</td>
                    <td>
                      <span className="row nowrap gap-3">
                        <Img icon="gamepad-2" src={g.icon?.url} alt="" className="tiny" />
                        <span className="stack gap-0">
                          <span className="row gap-2">
                            <span className="small strong">{g.title}</span>
                            {g.featured && <Badge tone="brand">Featured</Badge>}
                          </span>
                          <span className="xs muted">{g.playersLabel ?? `/play/games/${g.slug}`}</span>
                        </span>
                      </span>
                    </td>
                    <td className="small">{g.genre}</td>
                    <td>
                      <span className="stack gap-0">
                        <span className="small">{g.prizes.length ? plural(g.prizes.length, 'tier') : '—'}</span>
                        {idle > 0 && <span className="xs t-warning-text">{plural(idle, 'campaign')} not running</span>}
                        {!idle && unlinked > 0 && <span className="xs muted">{unlinked} without a coupon</span>}
                      </span>
                    </td>
                    <td>
                      <span className="stack gap-0">
                        <span className="small">{g.scoresLive ? `${num(g.scoreCount)} posted ${g.scoreCount === 1 ? 'score' : 'scores'}` : 'Staff table'}</span>
                        <span className="xs muted">
                          {plural(g.activeKeyCount, 'active key')}
                          {!g.scoresLive && g.rankingsUpdatedAt ? ` · updated ${dateTime(g.rankingsUpdatedAt)}` : ''}
                        </span>
                      </span>
                    </td>
                    <td className="small nowrap">{ratingText(g)}</td>
                    <td>
                      <StatusBadge status={SHOWN_STATUS[g.status]} tone={g.status === 'published' ? 'success' : ''} />
                    </td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setTried(false), setError(''), setDraft(draftOf(g)))}>
                        {canEdit ? 'Edit' : 'View'}
                        <span className="sr-only"> {g.title}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState icon="gamepad-2" title="No games yet">
                      Add the games the Play center lists.
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot">
          <span className="xs muted">The app lists published games in this order; a featured game shows large at the top. Reviews are moderated in Departments › Reviews.</span>
        </div>
      </section>

      <Drawer
        open={!!editing}
        onClose={close}
        className="wide"
        title={editing?.id ? `Edit game: ${editing.title || 'Untitled'}` : 'Add game'}
        foot={
          canEdit ? (
            <>
              {editing?.id && (
                <Button variant="danger-soft" size="sm" onClick={() => editing && remove.mutate(editing)} disabled={save.isPending || remove.isPending}>
                  Delete
                </Button>
              )}
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} disabled={save.isPending || remove.isPending}>
                {editing?.id ? 'Save game' : 'Add game'}
              </Button>
            </>
          ) : undefined
        }
      >
        {editing && (
          <fieldset className="stack gap-4" disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
            {error && (
              <Alert tone="danger" title="The game wasn’t saved">
                {error}
              </Alert>
            )}
            <Field label="Name" error={errs?.title}>
              <TextInput id="dg-title" value={editing.title} error={!!errs?.title} onChange={(e) => setD({ title: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional hint={`/play/games/${editing.slug.trim() || slugify(editing.title) || '…'}`}>
                <TextInput id="dg-slug" value={editing.slug} placeholder={slugify(editing.title)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Genre" hint="Shown as a chip in the app, e.g. Puzzle" error={errs?.genre}>
                <TextInput id="dg-genre" list="dg-genres" value={editing.genre} error={!!errs?.genre} onChange={(e) => setD({ genre: e.target.value })} />
              </Field>
            </div>
            <datalist id="dg-genres">
              {genres.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <div className="grid md2 gap-3">
              <Field label="Players line" optional hint="e.g. 12k players this week">
                <TextInput id="dg-players" value={editing.playersLabel} onChange={(e) => setD({ playersLabel: e.target.value })} />
              </Field>
              <Field label="Order" optional hint="Lower numbers show first">
                <TextInput id="dg-pos" type="number" min={1} value={editing.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
            <Switch id="dg-featured" label="Feature this game at the top of the list" checked={editing.featured} onChange={(e) => setD({ featured: e.target.checked })} />
            <PictureField label="Icon" shape="square" icon="gamepad-2" value={editing.icon} alt={editing.title.trim()} hint="Square, saved at 600 × 600. Shown in the game list." disabled={!canEdit} onChange={(icon) => setD({ icon })} />
            <PictureField label="Cover" shape="wide" icon="gamepad-2" value={editing.cover} alt={editing.title.trim()} hint="16 : 9, saved at 1200 × 675. Shown on the featured card and the game page." disabled={!canEdit} onChange={(cover) => setD({ cover })} />
            <Field label="Description" optional>
              <Textarea id="dg-desc" rows={3} value={editing.description} onChange={(e) => setD({ description: e.target.value })} />
            </Field>
            <div className="stack gap-2">
              <span className="label">How to play</span>
              <ol className="stack gap-2" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                {editing.howToPlay.map((s, i) => (
                  <li key={i} className="row gap-2 nowrap">
                    <span className="xs muted num">{i + 1}</span>
                    <TextInput id={`dg-step-${i}`} aria-label={`Step ${i + 1}`} value={s} onChange={(e) => setStep(i, e.target.value)} />
                    {canEdit && (
                      <>
                        <IconButton icon="arrow-up" label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => moveStep(i, -1)} />
                        <IconButton icon="arrow-down" label={`Move step ${i + 1} down`} disabled={i === editing.howToPlay.length - 1} onClick={() => moveStep(i, 1)} />
                        <IconButton icon="x" label={`Remove step ${i + 1}`} onClick={() => setD({ howToPlay: editing.howToPlay.filter((_, k) => k !== i) })} />
                      </>
                    )}
                  </li>
                ))}
              </ol>
              {canEdit && (
                <Button variant="secondary" size="sm" icon="plus" onClick={() => setD({ howToPlay: [...editing.howToPlay, ''] })}>
                  Add a step
                </Button>
              )}
            </div>
            <div className="stack gap-2">
              <span className="label">Prizes for top ranks</span>
              <span className="xs sub">Each prize week (Monday–Sunday, market time) the players in a tier’s ranks get their own code of the tier’s coupon campaign, in Account › Coupons.</span>
              {editing.prizes.map((p, i) => (
                <div key={i} className="stack gap-2" style={tierBox}>
                  <div className="row between gap-2">
                    <span className="small strong">
                      Prize {i + 1} · {rankLabel(p)}
                    </span>
                    {canEdit && <IconButton icon="x" label={`Remove prize ${i + 1}`} onClick={() => setD({ prizes: editing.prizes.filter((_, k) => k !== i) })} />}
                  </div>
                  <div className="grid gap-2" style={{ gridTemplateColumns: '90px 90px minmax(0, 1fr)' }}>
                    <Field label="From rank">
                      <TextInput id={`dg-pr-f-${i}`} inputMode="numeric" value={p.from} onChange={(e) => setPrize(i, { from: e.target.value })} />
                    </Field>
                    <Field label="To rank">
                      <TextInput id={`dg-pr-t-${i}`} inputMode="numeric" placeholder={p.from} value={p.to} onChange={(e) => setPrize(i, { to: e.target.value })} />
                    </Field>
                    <Field label="Reward">
                      <TextInput id={`dg-pr-w-${i}`} placeholder="$20 coupon" value={p.reward} onChange={(e) => setPrize(i, { reward: e.target.value })} />
                    </Field>
                  </div>
                  {campaigns.isError || !canEdit ? (
                    <Field label="Coupon campaign id" optional hint={campaigns.isError ? 'The campaigns couldn’t be listed (it needs the promotions permission): paste the campaign’s id' : (p.campaignName ?? 'No coupon: the tier is shown but nothing is given')}>
                      <TextInput id={`dg-pr-c-${i}`} value={p.campaignId} onChange={(e) => setPrize(i, { campaignId: e.target.value.trim(), campaignName: null, campaignActive: null })} />
                    </Field>
                  ) : (
                    <Field label="Coupon campaign" optional hint={<>Without one, the tier is shown but nothing is given. <Link to={href('admin/promotions')}>Promotions and coupons</Link> makes and runs campaigns.</>}>
                      <Select
                        id={`dg-pr-c-${i}`}
                        value={p.campaignId}
                        disabled={campaigns.isPending}
                        options={[
                          { value: '', label: campaigns.isPending ? 'Loading campaigns…' : 'No coupon' },
                          ...(p.campaignId && !options.some((c) => c.id === p.campaignId) ? [{ value: p.campaignId, label: p.campaignName ?? 'Current campaign' }] : []),
                          ...options.map((c) => ({ value: c.id, label: `${c.name} · ${c.ref}${c.status === 'live' ? '' : ` · ${c.status.replace(/_/g, ' ')}`}` })),
                        ]}
                        onChange={(e) => pickCampaign(i, e.target.value)}
                      />
                    </Field>
                  )}
                  {p.campaignId && p.campaignActive != null && (
                    <span className="row gap-2 items-center">
                      {p.campaignActive ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Not running</Badge>}
                      <span className="xs muted">{p.campaignActive ? `${p.campaignName ?? 'The campaign'} can give codes.` : `${p.campaignName ?? 'The campaign'} can’t give codes now: winners are tried again every hour once it runs.`}</span>
                    </span>
                  )}
                </div>
              ))}
              {errs?.prizes && <span className="xs t-danger-text">{errs.prizes}</span>}
              {canEdit && (
                <Button variant="secondary" size="sm" icon="plus" onClick={() => setD({ prizes: [...editing.prizes, emptyPrize(editing.prizes[editing.prizes.length - 1])] })} disabled={editing.prizes.length >= 10}>
                  Add a prize
                </Button>
              )}
              <span className="xs sub">With prizes, the app shows the Win coupons badge on the game.</span>
            </div>
            <Field label="Prize note" optional hint={`Under the rewards in the app, e.g. Coupons land in Account › Coupons on Monday. Minimum order $30. · ${editing.prizeNote.trim().length} of ${PRIZE_NOTE_MAX}`} error={errs?.prizeNote}>
              <Textarea id="dg-prize-note" rows={2} value={editing.prizeNote} onChange={(e) => setD({ prizeNote: e.target.value })} />
            </Field>
            <Field label="Status">
              <Select id="dg-status" value={editing.status} options={[{ value: 'published', label: 'Published: customers see it' }, { value: 'hidden', label: 'Hidden' }]} onChange={(e) => setD({ status: e.target.value as Game['status'] })} />
            </Field>
          </fieldset>
        )}
      </Drawer>
    </>
  );
}
const tierBox = { padding: 12, border: '1px solid var(--border)', borderRadius: 10 } as const;

/* ---------------- Rankings ---------------- */

type Row = { name: string; score: string; change: string };

function RankingsTab({ notify, canEdit, games }: { notify: Notify; canEdit: boolean; games: Game[] }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [gameId, setGameId] = useState(ordered(games)[0]?.id ?? '');
  const [period, setPeriod] = useState<Period>('week');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');

  const table = useQuery({
    queryKey: ['departments', 'play', 'rankings', gameId, period],
    enabled: !!gameId,
    queryFn: () => call(api.GET('/api/admin/departments/play/games/{id}/rankings/{period}', { params: { path: { id: gameId, period } } })),
  });
  // a new game or period starts from what is saved
  useEffect(() => {
    setRows(null);
    setTried(false);
    setError('');
  }, [gameId, period]);
  const fromScores = table.data?.source === 'scores';
  const editable = canEdit && !fromScores;
  const saved: Row[] = (table.data?.entries ?? []).map((e) => ({ name: e.name, score: String(e.score), change: e.change == null ? '' : String(e.change) }));
  const list = rows ?? saved;
  const dirty = rows !== null;
  const bad = (r: Row) => !r.name.trim() || !/^\d+$/.test(r.score.trim()) || (r.change.trim() !== '' && !/^-?\d+$/.test(r.change.trim()));
  const setRow = (i: number, patch: Partial<Row>) => setRows(list.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const save = useMutation({
    mutationFn: () => call(api.PUT('/api/admin/departments/play/games/{id}/rankings/{period}', { params: { path: { id: gameId, period } }, body: { entries: list.map((r) => ({ name: r.name.trim(), score: Number(r.score), change: r.change.trim() === '' ? null : Number(r.change) })) } })),
    onSuccess: (t) => {
      qc.setQueryData(['departments', 'play', 'rankings', gameId, period], t);
      void qc.invalidateQueries({ queryKey: ['departments', 'play', 'games'] });
      setRows(null);
      notify(`${t.game.title} · ${PERIODS.find((p) => p.value === period)?.label}: ${plural(t.entries.length, 'player')} saved`);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    setTried(true);
    if (list.some(bad)) return;
    save.mutate();
  };

  if (!games.length) return <NoGames icon="trophy" what="Ranking tables" />;

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <GamePicker id="dk-game" games={games} value={gameId} onChange={setGameId} />
          <SegmentedControl items={PERIODS.map((p) => ({ label: p.label, value: p.value }))} active={period} onChange={setPeriod} label="Period" />
          {table.data && (
            <span className="xs muted">
              {plural(table.data.playerCount, 'player')} · prize week {table.data.week.endsLabel.replace(/^Ends/, 'ends')}
            </span>
          )}
        </div>
      </div>
      {fromScores && (
        <div className="card-body">
          <Alert tone="info" title="Worked out from the scores the game posts.">
            Each player’s best score in the period, ties going to whoever reached it first. Only games without posted scores use a staff table.
          </Alert>
        </div>
      )}
      {error && (
        <div className="card-body">
          <Alert tone="danger" title="The rankings weren’t saved">
            {error}
          </Alert>
        </div>
      )}
      {table.isError ? (
        <div className="card-body">
          <LoadError error={table.error} onRetry={() => void table.refetch()} />
        </div>
      ) : table.isPending ? (
        <div className="card-body">
          <SkeletonLines rows={5} />
        </div>
      ) : (
        <TableWrap label="Ranking table">
          <table className="table">
            <thead>
              <tr>
                <th className="r" scope="col">
                  {fromScores ? 'Rank' : 'Row'}
                </th>
                <th scope="col">Player name</th>
                <th scope="col">Score</th>
                <th scope="col">Places moved</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) =>
                editable ? (
                  <tr key={i} className={tried && bad(r) ? 'is-warn' : undefined}>
                    <td className="r small">{i + 1}</td>
                    <td>
                      <TextInput id={`dk-n-${i}`} aria-label={`Row ${i + 1} name`} value={r.name} error={tried && !r.name.trim()} onChange={(e) => setRow(i, { name: e.target.value })} />
                    </td>
                    <td>
                      <TextInput id={`dk-s-${i}`} aria-label={`Row ${i + 1} score`} inputMode="numeric" value={r.score} error={tried && !/^\d+$/.test(r.score.trim())} onChange={(e) => setRow(i, { score: e.target.value })} />
                    </td>
                    <td>
                      <TextInput id={`dk-c-${i}`} aria-label={`Row ${i + 1} places moved`} inputMode="numeric" placeholder="New" value={r.change} error={tried && r.change.trim() !== '' && !/^-?\d+$/.test(r.change.trim())} onChange={(e) => setRow(i, { change: e.target.value })} />
                    </td>
                    <td>
                      <IconButton icon="x" label={`Remove row ${i + 1}`} onClick={() => setRows(list.filter((_, k) => k !== i))} />
                    </td>
                  </tr>
                ) : (
                  <tr key={i}>
                    <td className="r small">{table.data?.entries[i]?.rank ?? i + 1}</td>
                    <td className="small">{r.name}</td>
                    <td className="small">{num(Number(r.score))}</td>
                    <td className="small">{r.change === '' ? 'New' : Number(r.change) > 0 ? `↑ ${r.change}` : Number(r.change) < 0 ? `↓ ${-Number(r.change)}` : '—'}</td>
                    <td />
                  </tr>
                ),
              )}
              {list.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState icon="trophy" title="No rankings for this period yet">
                      {fromScores ? 'No scores were posted in this period.' : 'Add the players and their scores. The app ranks them by score, best first.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
      )}
      <div className="card-foot between">
        <span className="xs muted">
          {tried && list.some(bad) ? <span className="t-danger-text">Each row needs a name and a whole-number score; places moved is a whole number (negative = down) or blank for new.</span> : `Ranks follow the score, best first · ${table.data?.updatedAt ? `updated ${dateTime(table.data.updatedAt)}` : 'never updated'}${dirty ? ' · unsaved changes' : ''}`}
        </span>
        {editable && (
          <span className="row gap-2">
            <Button variant="secondary" size="sm" icon="plus" onClick={() => setRows([...list, { name: '', score: '', change: '' }])} disabled={list.length >= MAX_ROWS}>
              Add row
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRows(null)} disabled={!dirty || save.isPending}>
              Discard
            </Button>
            <Button size="sm" onClick={submit} disabled={!dirty || save.isPending}>
              Save rankings
            </Button>
          </span>
        )}
      </div>
    </section>
  );
}

/* ---------------- Server keys ---------------- */

type KeyAction = { kind: 'rotate' | 'revoke'; key: GameKey };

function KeysTab({ notify, canKeys, games }: { notify: Notify; canKeys: boolean; games: Game[] }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [gameId, setGameId] = useState(ordered(games)[0]?.id ?? '');
  const [confirm, setConfirm] = useState<KeyAction | null>(null);
  const [secret, setSecret] = useState<{ value: string; hint: string } | null>(null);
  const [error, setError] = useState('');
  const game = games.find((g) => g.id === gameId);
  const keys = useQuery({
    queryKey: ['departments', 'play', 'keys', gameId],
    enabled: !!gameId,
    queryFn: () => call(api.GET('/api/admin/departments/play/games/{id}/keys', { params: { path: { id: gameId } } })),
  });
  const active = (keys.data ?? []).filter((k) => k.status === 'active').length;
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['departments', 'play', 'keys', gameId] });
    void qc.invalidateQueries({ queryKey: ['departments', 'play', 'games'] });
  };
  const failed = (e: unknown) => setError(codeOf(e) === 'TOO_MANY_KEYS' ? `${game?.title ?? 'The game'} already has two active keys: rotate or revoke one first.` : codeOf(e) === 'ILLEGAL_TRANSITION' ? 'That key was already revoked.' : errorMessage(e));
  const create = useMutation({
    mutationFn: () => call(api.POST('/api/admin/departments/play/games/{id}/keys', { params: { path: { id: gameId } } })),
    onSuccess: (s) => (done(), setError(''), setSecret({ value: s.secret, hint: s.key.hint })),
    onError: failed,
  });
  const act = useMutation({
    mutationFn: ({ kind, key }: KeyAction) =>
      kind === 'rotate'
        ? call(api.POST('/api/admin/departments/play/games/{id}/keys/{keyId}/rotate', { params: { path: { id: gameId, keyId: key.id } } })).then((s) => ({ secret: s.secret, hint: s.key.hint }))
        : call(api.POST('/api/admin/departments/play/games/{id}/keys/{keyId}/revoke', { params: { path: { id: gameId, keyId: key.id } } })).then(() => null),
    onSuccess: (s, v) => {
      done();
      setConfirm(null);
      setError('');
      if (s) setSecret({ value: s.secret, hint: s.hint });
      else notify(`Key ${v.key.hint} revoked: it can’t post scores any more`);
    },
    onError: (e) => (setConfirm(null), failed(e)),
  });

  if (!games.length) return <NoGames icon="key-round" what="Server keys" />;

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar between">
          <GamePicker id="dkk-game" games={games} value={gameId} onChange={(v) => (setGameId(v), setError(''))} />
          {canKeys && (
            <Button size="sm" icon="key-round" onClick={() => create.mutate()} disabled={create.isPending || keys.isPending || active >= MAX_ACTIVE_KEYS}>
              Make a server key
            </Button>
          )}
        </div>
      </div>
      {!canKeys && (
        <div className="card-body">
          <Alert tone="info" title="View only: making, rotating and revoking keys needs the server keys permission." />
        </div>
      )}
      {error && (
        <div className="card-body">
          <Alert tone="danger" title={error} />
        </div>
      )}
      {keys.isError ? (
        <div className="card-body">
          <LoadError error={keys.error} onRetry={() => void keys.refetch()} />
        </div>
      ) : (
        <TableWrap label="Server keys table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Status</th>
                <th scope="col">Made</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.isPending && (
                <tr>
                  <td colSpan={5}>
                    <SkeletonLines rows={3} />
                  </td>
                </tr>
              )}
              {(keys.data ?? []).map((k) => (
                <tr key={k.id}>
                  <td className="mono small strong">{k.hint}</td>
                  <td>{k.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge icon="ban">Revoked {k.revokedAt ? dateTime(k.revokedAt) : ''}</Badge>}</td>
                  <td className="small nowrap">{dateTime(k.createdAt)}</td>
                  <td className="small nowrap">{k.lastUsedAt ? dateTime(k.lastUsedAt) : 'Never'}</td>
                  <td>
                    {canKeys && k.status === 'active' && (
                      <span className="row gap-1 nowrap">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setError(''), setConfirm({ kind: 'rotate', key: k }))} disabled={act.isPending}>
                          Rotate<span className="sr-only"> key {k.hint}</span>
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm t-danger-text" onClick={() => (setError(''), setConfirm({ kind: 'revoke', key: k }))} disabled={act.isPending}>
                          Revoke<span className="sr-only"> key {k.hint}</span>
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {keys.isSuccess && keys.data.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState icon="key-round" title={`${game?.title ?? 'This game'} has no server keys`}>
                      Make a key for the game’s partner. Their server sends it to post customers’ scores; until then the game keeps the staff table.
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
      )}
      <div className="card-foot">
        <span className="xs muted">
          The game’s server posts scores to <span className="mono">POST /webhooks/departments/play/scores</span> with the key in the <span className="mono">X-Game-Key</span> header, naming the customer by their player ID. At most {MAX_ACTIVE_KEYS} active keys per game, so a partner can switch keys without missing scores. Marketly keeps only a hash of each key.
          {game && ` · ${game.title}: ${plural(game.scoreCount, 'posted score')}.`}
        </span>
      </div>

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'rotate' ? `Rotate key ${confirm.key.hint}?` : `Revoke key ${confirm?.key.hint ?? ''}?`}
        foot={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep it
            </Button>
            <Button variant={confirm?.kind === 'revoke' ? 'danger' : 'primary'} onClick={() => confirm && act.mutate(confirm)} disabled={act.isPending}>
              {confirm?.kind === 'rotate' ? 'Rotate key' : 'Revoke key'}
            </Button>
          </>
        }
      >
        <p className="small" style={{ margin: 0 }}>
          {confirm?.kind === 'rotate'
            ? `The old key stops working now and a new one is shown once. ${game?.title ?? 'The game'}’s partner must switch to the new key, or their scores are refused.`
            : `The key stops posting scores now. ${game?.title ?? 'The game'}’s partner can’t post with it again; make a new key if they need one.`}
        </p>
      </Dialog>

      <Dialog
        open={!!secret}
        onClose={() => setSecret(null)}
        dismissable={false}
        title={`Server key for ${game?.title ?? 'the game'}`}
        foot={
          <Button onClick={() => (setSecret(null), notify(`Key ${secret?.hint ?? ''} is active: send it to ${game?.title ?? 'the game'}’s partner securely`))}>
            I’ve copied the key
          </Button>
        }
      >
        <Alert tone="warning" title="Copy it now: you won’t see it again.">
          Marketly keeps only a hash of the key, so nobody can show it later. If it’s lost, rotate the key.
        </Alert>
        {secret && (
          <div className="row gap-2 nowrap items-center" style={{ ...tierBox, background: 'var(--surface-2)' }}>
            <code className="mono small grow" style={{ wordBreak: 'break-all' }}>
              {secret.value}
            </code>
            <CopyButton text={secret.value}>Copy key</CopyButton>
          </div>
        )}
        <p className="xs sub" style={{ margin: 0 }}>
          Send it to the game’s partner over a secure channel. Their server sends it in the X-Game-Key header.
        </p>
      </Dialog>
    </section>
  );
}

/* ---------------- Prize coupons ---------------- */

function AwardsTab({ games }: { games: Game[] }) {
  const { api } = useApi();
  const [gameId, setGameId] = useState(ordered(games)[0]?.id ?? '');
  const [state, setState] = useState<'' | PrizeAward['state']>('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['departments', 'play', 'awards', gameId, state, page],
    enabled: !!gameId,
    queryFn: () => call(api.GET('/api/admin/departments/play/games/{id}/awards', { params: { path: { id: gameId }, query: { state: state || undefined, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  // rows arrive newest week first: a week heading before each new week
  const weekStarts = new Set(rows.filter((a, i) => i === 0 || rows[i - 1].week !== a.week).map((a) => a.id));
  const game = games.find((g) => g.id === gameId);

  if (!games.length) return <NoGames icon="ticket-percent" what="Prize coupons" />;

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <GamePicker id="dka-game" games={games} value={gameId} onChange={(v) => (setGameId(v), setPage(1))} />
          <select className="select" id="dka-state" aria-label="State" value={state} onChange={(e) => (setState(e.target.value as '' | PrizeAward['state']), setPage(1))}>
            <option value="">All coupons</option>
            <option value="issued">Given</option>
            <option value="failed">Not given yet</option>
          </select>
        </div>
      </div>
      {list.isError && (
        <div className="card-body">
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        </div>
      )}
      <TableWrap label="Prize coupons table">
        <table className="table">
          <thead>
            <tr>
              <th className="r" scope="col">
                Rank
              </th>
              <th scope="col">Player</th>
              <th className="r" scope="col">
                Score
              </th>
              <th scope="col">Reward</th>
              <th scope="col">Code</th>
              <th scope="col">State</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr>
                <td colSpan={7}>
                  <SkeletonLines rows={5} />
                </td>
              </tr>
            )}
            {rows.map((a) => (
              <AwardRow key={a.id} a={a} heading={weekStarts.has(a.id)} />
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState icon="ticket-percent" title={state ? 'No coupons here' : 'No prize coupons yet'}>
                    {game && !game.prizes.some((p) => p.campaignId) ? `${game.title} has no prize tier linked to a coupon campaign: add one on the Games tab.` : 'When a prize week ends, each winner’s coupon shows here.'}
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot between">
        <span className="xs muted">Prize weeks run Monday–Sunday, market time, and are settled hourly after they end; a coupon that couldn’t be given is tried again every hour.</span>
        <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
      </div>
    </section>
  );
}

function AwardRow({ a, heading }: { a: PrizeAward; heading: boolean }) {
  return (
    <>
      {heading && (
        <tr>
          <th colSpan={7} scope="colgroup" className="xs muted" style={{ textAlign: 'left', background: 'var(--surface-2)' }}>
            Week of {date(a.week)}
          </th>
        </tr>
      )}
      <tr>
        <td className="r small">#{a.rank}</td>
        <td>
          <span className="stack gap-0">
            <Link className="small strong" to={href('admin/customers', 'customer-detail', undefined, { customer: a.customerId })}>
              {a.name}
            </Link>
            <span className="xs muted mono">{a.customerId}</span>
          </span>
        </td>
        <td className="r small">{num(a.score)}</td>
        <td className="small">{a.reward}</td>
        <td className="mono small">{a.code ?? '—'}</td>
        <td>
          {a.state === 'issued' ? (
            <Badge tone="success">Given</Badge>
          ) : (
            <span className="stack gap-0">
              <Badge tone="danger">Not given yet</Badge>
              {a.error && <span className="xs t-danger-text">{a.error}</span>}
            </span>
          )}
        </td>
        <td className="small nowrap">{dateTime(a.at)}</td>
      </tr>
    </>
  );
}

/* ---------------- Player IDs ---------------- */

function PlayersTab() {
  const { api } = useApi();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const found = useQuery({
    queryKey: ['departments', 'play', 'players', term],
    enabled: term.length >= 2,
    queryFn: () => call(api.GET('/api/admin/departments/play/players', { params: { query: { q: term } } })),
    placeholderData: keepPreviousData,
  });
  const rows = term.length >= 2 ? (found.data ?? []) : [];

  return (
    <section className="card">
      <div className="card-body stack gap-2">
        <div className="toolbar">
          <SearchInput id="dkp-q" placeholder="Customer name or email" value={q} onChange={setQ} label="Find a customer’s player ID" />
        </div>
        <span className="xs sub">A game partner names customers by the player ID the customer copies from the app (e.g. MK-7F3K-92QD). Find a customer’s ID here to help a partner with a missing score.</span>
      </div>
      {found.isError && (
        <div className="card-body">
          <LoadError error={found.error} onRetry={() => void found.refetch()} />
        </div>
      )}
      <TableWrap label="Player IDs table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col">Player ID</th>
              <th scope="col">Customer id</th>
            </tr>
          </thead>
          <tbody>
            {term.length >= 2 && found.isPending && (
              <tr>
                <td colSpan={3}>
                  <SkeletonLines rows={3} />
                </td>
              </tr>
            )}
            {rows.map((p) => (
              <tr key={p.customerId}>
                <td>
                  <Link className="small strong" to={href('admin/customers', 'customer-detail', undefined, { customer: p.customerId })}>
                    {p.name}
                  </Link>
                </td>
                <td>
                  <span className="row gap-2 nowrap items-center">
                    <span className="mono small strong">{p.playerId}</span>
                    <CopyButton text={p.playerId} label={`Copy ${p.name}’s player ID`} />
                  </span>
                </td>
                <td className="mono xs muted">{p.customerId}</td>
              </tr>
            ))}
            {(term.length < 2 || (found.isSuccess && rows.length === 0)) && (
              <tr>
                <td colSpan={3}>
                  <EmptyState icon="id-card" title={term.length < 2 ? 'Search for a customer' : 'No customers match'}>
                    {term.length < 2 ? 'Type at least 2 characters of their name or email.' : 'Try their full email address.'}
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot">
        <span className="xs muted">Up to 20 customers · a customer without a player ID gets one when found here.</span>
      </div>
    </section>
  );
}
