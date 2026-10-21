import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { useView } from '@marketly/web-shared/lib/hooks';
import { Alert, announce, Badge, Button, Drawer, EmptyState, Field, IconButton, Img, PageHeader, SegmentedControl, Select, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, SkeletonLines } from '@/app/parts';
import { DeptPage, PERIODS, PictureField, plural, SHOWN_STATUS, slugify, type Game, type GameInput, type MediaRef, type Period } from './data/departments';

// Admin › Departments › Play center (designed in React from the Marketly Departments canvas). List only at this
// phase (2026-10-21 decision): staff keep the games and their ranking tables; playing and score submission come
// later. Tabs: Games | Rankings. API: /api/admin/departments/play/games, …/games/{id}/rankings/{period}.

type Tab = '' | 'rankings';
type Notify = (title: string, tone?: 'success' | 'danger') => void;
const MAX_ROWS = 100;

export default function DeptPlay() {
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('departments.view');
  const canEdit = can('departments.play.manage');
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };
  const games = useQuery({ queryKey: ['departments', 'play', 'games'], enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/play/games')) });

  return (
    <DeptPage active="dept-play" title="Play center" canView={canView}>
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Play center' }]}
        title="Play center"
        sub={canEdit ? 'Games and ranking tables of the app’s Play center · the carousel at the top is the play_top ad placement' : 'View only: editing needs the Play center permission'}
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
        ]}
        active={view}
        onChange={(v) => {
          setNotice(null);
          setView(v as Tab);
        }}
        label="Play center"
      />
      <Alert tone="info" title="Playing comes later: these tables are entered by staff.">
        The app lists the games and shows the rankings you keep here. Its Play button says Coming soon.
      </Alert>
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      {games.isError ? (
        <LoadError error={games.error} onRetry={() => void games.refetch()} />
      ) : games.isPending ? (
        <section className="card">
          <div className="card-body">
            <SkeletonLines rows={5} />
          </div>
        </section>
      ) : view === 'rankings' ? (
        <RankingsTab notify={notify} canEdit={canEdit} games={games.data} />
      ) : (
        <GamesTab notify={notify} canEdit={canEdit} games={games.data} adding={adding} setAdding={setAdding} />
      )}
    </DeptPage>
  );
}

/* ---------------- Games ---------------- */

type GameDraft = { id: string; title: string; slug: string; genre: string; icon: MediaRef | null; cover: MediaRef | null; playersLabel: string; featured: boolean; description: string; howToPlay: string[]; prizes: Array<{ ranks: string; reward: string }>; status: Game['status']; position: string };
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
  prizes: g?.prizes?.map((p) => ({ ...p })) ?? [],
  status: g?.status ?? 'hidden',
  position: g ? String(g.position) : '',
});

function GamesTab({ notify, canEdit, games, adding, setAdding }: { notify: Notify; canEdit: boolean; games: Game[]; adding: boolean; setAdding: (v: boolean) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<GameDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const rows = [...games].sort((a, b) => a.position - b.position);
  const genres = [...new Set(games.map((g) => g.genre).filter(Boolean))];

  const editing = draft ?? (adding ? draftOf() : null);
  const setD = (patch: Partial<GameDraft>) => editing && setDraft({ ...editing, ...patch });
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const errs = tried && editing ? { title: editing.title.trim() ? '' : 'Enter the game’s name.', genre: editing.genre.trim() ? '' : 'Enter the genre, e.g. Puzzle.', prizes: editing.prizes.some((p) => !p.ranks.trim() !== !p.reward.trim()) ? 'Fill in both the ranks and the reward of each prize, or remove it.' : '' } : null;

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
        prizes: d.prizes.filter((p) => p.ranks.trim() && p.reward.trim()).map((p) => ({ ranks: p.ranks.trim(), reward: p.reward.trim() })),
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
    onError: (e) => setError(errorMessage(e)),
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
    if (!editing.title.trim() || !editing.genre.trim() || editing.prizes.some((p) => !p.ranks.trim() !== !p.reward.trim())) return;
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
  const setPrize = (i: number, patch: Partial<{ ranks: string; reward: string }>) => editing && setD({ prizes: editing.prizes.map((p, k) => (k === i ? { ...p, ...patch } : p)) });

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
                <th scope="col">Status</th>
                <th scope="col">Rankings updated</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
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
                  <td className="small">{g.prizes.length ? plural(g.prizes.length, 'prize') : '—'}</td>
                  <td>
                    <StatusBadge status={SHOWN_STATUS[g.status]} tone={g.status === 'published' ? 'success' : ''} />
                  </td>
                  <td className="small">{g.rankingsUpdatedAt ? dateTime(g.rankingsUpdatedAt) : 'Never'}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setTried(false), setError(''), setDraft(draftOf(g)))}>
                      {canEdit ? 'Edit' : 'View'}
                      <span className="sr-only"> {g.title}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
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
          <span className="xs muted">The app lists published games in this order; a featured game shows large at the top.</span>
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
              {editing.prizes.map((p, i) => (
                <div key={i} className="row gap-2 nowrap">
                  <TextInput id={`dg-pr-r-${i}`} aria-label={`Prize ${i + 1} ranks`} placeholder="#1 or #4–10" value={p.ranks} onChange={(e) => setPrize(i, { ranks: e.target.value })} />
                  <TextInput id={`dg-pr-w-${i}`} aria-label={`Prize ${i + 1} reward`} placeholder="$20 coupon" value={p.reward} onChange={(e) => setPrize(i, { reward: e.target.value })} />
                  {canEdit && <IconButton icon="x" label={`Remove prize ${i + 1}`} onClick={() => setD({ prizes: editing.prizes.filter((_, k) => k !== i) })} />}
                </div>
              ))}
              {errs?.prizes && <span className="xs t-danger-text">{errs.prizes}</span>}
              {canEdit && (
                <Button variant="secondary" size="sm" icon="plus" onClick={() => setD({ prizes: [...editing.prizes, { ranks: '', reward: '' }] })}>
                  Add a prize
                </Button>
              )}
              <span className="xs sub">With prizes, the app shows the Win coupons badge on the game.</span>
            </div>
            <Field label="Status">
              <Select id="dg-status" value={editing.status} options={[{ value: 'published', label: 'Published: customers see it' }, { value: 'hidden', label: 'Hidden' }]} onChange={(e) => setD({ status: e.target.value as Game['status'] })} />
            </Field>
          </fieldset>
        )}
      </Drawer>
    </>
  );
}

/* ---------------- Rankings ---------------- */

type Row = { name: string; score: string; change: string };

function RankingsTab({ notify, canEdit, games }: { notify: Notify; canEdit: boolean; games: Game[] }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const sorted = [...games].sort((a, b) => a.position - b.position);
  const [gameId, setGameId] = useState(sorted[0]?.id ?? '');
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

  if (!games.length) {
    return (
      <section className="card">
        <div className="card-body">
          <EmptyState icon="trophy" title="Add a game first">
            Ranking tables belong to a game.
          </EmptyState>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <select className="select" id="dk-game" aria-label="Game" value={gameId} onChange={(e) => setGameId(e.target.value)}>
            {sorted.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
                {g.status === 'hidden' ? ' (hidden)' : ''}
              </option>
            ))}
          </select>
          <SegmentedControl items={PERIODS.map((p) => ({ label: p.label, value: p.value }))} active={period} onChange={setPeriod} label="Period" />
        </div>
      </div>
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
                  Row
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
              {list.map((r, i) => (
                <tr key={i} className={tried && bad(r) ? 'is-warn' : undefined}>
                  <td className="r small">{i + 1}</td>
                  <td>
                    <TextInput id={`dk-n-${i}`} aria-label={`Row ${i + 1} name`} value={r.name} disabled={!canEdit} error={tried && !r.name.trim()} onChange={(e) => setRow(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <TextInput id={`dk-s-${i}`} aria-label={`Row ${i + 1} score`} inputMode="numeric" value={r.score} disabled={!canEdit} error={tried && !/^\d+$/.test(r.score.trim())} onChange={(e) => setRow(i, { score: e.target.value })} />
                  </td>
                  <td>
                    <TextInput id={`dk-c-${i}`} aria-label={`Row ${i + 1} places moved`} inputMode="numeric" placeholder="New" value={r.change} disabled={!canEdit} error={tried && r.change.trim() !== '' && !/^-?\d+$/.test(r.change.trim())} onChange={(e) => setRow(i, { change: e.target.value })} />
                  </td>
                  <td>{canEdit && <IconButton icon="x" label={`Remove row ${i + 1}`} onClick={() => setRows(list.filter((_, k) => k !== i))} />}</td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState icon="trophy" title="No rankings for this period yet">
                      Add the players and their scores. The app ranks them by score, best first.
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
        {canEdit && (
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
