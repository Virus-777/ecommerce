import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, announce, Badge, Button, EmptyState, Field, IconButton, Img, PageHeader, SearchInput, Select } from '@marketly/web-shared/ui';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, shortDate } from '@/app/parts';
import { DeptPage, LinesField, newKey, plural, slugify, type FarmMachineInput, type FarmType } from './data/departments';

// Admin › Departments › Farm machines (designed in React from the Marketly Departments canvas, FarmIntro and FarmOrder):
// the machine types of the app's Farm machines page and the machines staff pick from the catalog, each with its type,
// short spec lines and the attachments offered with it. Customers buy them through cart and checkout (renting is left out
// of v1). API: GET/PUT /api/admin/departments/farm; products come from GET /api/admin/catalog/products?q=.

const MAX_TYPES = 12;
const MAX_MACHINES = 100;
const MAX_ATTACHMENTS = 8;
type Info = { title: string; brand?: string | null; image?: string | null; price?: string | null; shown: boolean };
type Draft = { types: FarmType[]; machines: FarmMachineInput[] };

export default function DeptFarm() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canView = can('departments.view');
  const canEdit = can('departments.farm.manage');
  const [draft, setDraft] = useState<Draft | null>(null);
  // products added in this session, before they are saved and come back as cards
  const [added, setAdded] = useState<Record<string, Info>>({});
  const [q, setQ] = useState('');
  // the machine the search adds attachments to; null adds machines
  const [attachFor, setAttachFor] = useState<string | null>(null);
  const [newType, setNewType] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const farm = useQuery({ queryKey: ['departments', 'farm'], enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/farm')) });
  const term = q.trim();
  const search = useQuery({
    queryKey: ['catalog', 'products', 'farm-search', term],
    enabled: canEdit && term.length >= 2,
    queryFn: () => call(api.GET('/api/admin/catalog/products', { params: { query: { q: term, publication: 'active', limit: 8 } } })),
  });

  const saved: Draft = { types: farm.data?.types ?? [], machines: farm.data?.machines ?? [] };
  const d = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const cards = new Map((farm.data?.products ?? []).map((c) => [c.productId, c]));
  const infoOf = (id: string): Info => {
    const c = cards.get(id);
    if (c) return { title: c.title, brand: c.brandName, image: c.image?.url, price: formatMoney(c.price), shown: true };
    return added[id] ?? { title: 'Product not shown in the store', shown: false };
  };
  const usedBy = (typeId: string) => d.machines.filter((m) => m.typeId === typeId).length;

  const set = (next: Draft) => {
    setDraft(next);
    setNotice('');
  };
  const setTypes = (types: FarmType[]) => set({ ...d, types });
  const setMachine = (i: number, patch: Partial<FarmMachineInput>) => set({ ...d, machines: d.machines.map((m, k) => (k === i ? { ...m, ...patch } : m)) });
  const moveIn = <T,>(list: T[], i: number, dir: -1 | 1): T[] | null => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return null;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };
  const addType = () => {
    const name = newType.trim();
    if (!name || d.types.length >= MAX_TYPES) return;
    setTypes([...d.types, { id: newKey(), name, slug: slugify(name) }]);
    setNewType('');
    announce(`${name} added`);
  };

  const save = useMutation({
    mutationFn: () => call(api.PUT('/api/admin/departments/farm', { body: { types: d.types.map((t) => ({ ...t, name: t.name.trim(), slug: t.slug || slugify(t.name) })), machines: d.machines.map((m) => ({ ...m, highlights: (m.highlights ?? []).map((h) => h.trim()).filter(Boolean) })) } })),
    onSuccess: (r) => {
      qc.setQueryData(['departments', 'farm'], r);
      setDraft(null);
      setError('');
      const msg = `Farm machines saved: ${plural(r.types.length, 'type')}, ${plural(r.machines.length, 'machine')}. The app shows them now.`;
      setNotice(msg);
      announce(msg);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const problem = !d.types.length ? 'Add at least one machine type.' : d.types.some((t) => !t.name.trim()) ? 'Every type needs a name.' : d.machines.some((m) => !d.types.some((t) => t.id === m.typeId)) ? 'Pick a type for every machine.' : '';
  const target = attachFor ? d.machines.find((m) => m.productId === attachFor) : undefined;
  const taken = target ? [target.productId, ...(target.attachmentIds ?? [])] : d.machines.map((m) => m.productId);
  const results = (search.data?.items ?? []).filter((r) => !taken.includes(r.product.id));

  return (
    <DeptPage active="dept-farm" title="Farm machines" canView={canView}>
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Farm machines' }]}
        title="Farm machines"
        sub={`Machines of the app’s Farm machines page, bought through cart and checkout · ${canEdit ? 'pick machines from the catalog and group them by type' : 'view only: editing needs the Farm machines permission'}${farm.data?.updatedAt ? ` · saved ${shortDate(farm.data.updatedAt)}` : ''}`}
        actions={
          canEdit && (
            <>
              <Button variant="ghost" size="sm" onClick={() => (setDraft(null), setAttachFor(null))} disabled={!dirty || save.isPending}>
                Discard changes
              </Button>
              <Button size="sm" icon="check" onClick={() => (problem ? setError(problem) : save.mutate())} disabled={!dirty || save.isPending}>
                Save
              </Button>
            </>
          )
        }
      />
      {notice && <Alert tone="success" title={notice} />}
      {error && (
        <Alert tone="danger" title="The farm machines weren’t saved">
          {error}
        </Alert>
      )}
      <Alert tone="info" title="Renting comes later">
        The app sells these machines through cart and checkout, with the attachments picked here offered on the order page. Rental dates and installments are not part of this version.
      </Alert>
      {farm.isError ? (
        <LoadError error={farm.error} onRetry={() => void farm.refetch()} />
      ) : farm.isPending ? (
        <SkeletonLines rows={6} />
      ) : (
        <div className="ab-main">
          <div className="stack gap-5">
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h2 className="h4">Machine types</h2>
                  <span className="xs muted">The chips on the app’s Farm machines page, in this order · {plural(d.types.length, 'type')} of {MAX_TYPES}</span>
                </div>
              </div>
              <div className="card-body stack gap-3">
                {d.types.length === 0 && <span className="small muted">No types yet: add Tractors, Harvesters or Tillers below.</span>}
                {d.types.length > 0 && (
                  <ul className="list">
                    {d.types.map((t, i) => {
                      const n = usedBy(t.id);
                      return (
                        <li key={t.id}>
                          <span className="xs muted num">{i + 1}</span>
                          <input className="input grow" aria-label={`Type ${i + 1} name`} value={t.name} disabled={!canEdit} onChange={(e) => setTypes(d.types.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                          <span className="xs muted nowrap">{plural(n, 'machine')}</span>
                          {canEdit && (
                            <>
                              <IconButton icon="arrow-up" label={`Move ${t.name} up`} disabled={i === 0} onClick={() => setTypes(moveIn(d.types, i, -1) ?? d.types)} />
                              <IconButton icon="arrow-down" label={`Move ${t.name} down`} disabled={i === d.types.length - 1} onClick={() => setTypes(moveIn(d.types, i, 1) ?? d.types)} />
                              <IconButton icon="x" label={n ? `${t.name} is used by ${plural(n, 'machine')}: move them to another type first` : `Remove ${t.name}`} disabled={n > 0} onClick={() => setTypes(d.types.filter((x) => x.id !== t.id))} />
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {d.types.some((t) => usedBy(t.id) > 0) && canEdit && <span className="xs sub">A type that machines still use can’t be removed: give those machines another type first.</span>}
                {canEdit && d.types.length < MAX_TYPES && (
                  <div className="row gap-2">
                    <input className="input grow" id="df-type" placeholder="New type, e.g. Harvesters" value={newType} onChange={(e) => setNewType(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addType())} />
                    <Button variant="secondary" size="sm" icon="plus" onClick={addType} disabled={!newType.trim()}>
                      Add type
                    </Button>
                  </div>
                )}
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h2 className="h4">Picked machines</h2>
                  <span className="xs muted">
                    Shown in this order · {plural(d.machines.length, 'machine')} of {MAX_MACHINES}
                    {dirty ? ' · unsaved changes' : ''}
                  </span>
                </div>
              </div>
              {d.machines.length === 0 ? (
                <div className="card-body">
                  <EmptyState icon="tractor" title="No machines picked yet">
                    Search the catalog on the right and add the machines the Farm machines page should sell.
                  </EmptyState>
                </div>
              ) : (
                <ul className="list pad">
                  {d.machines.map((m, i) => {
                    const p = infoOf(m.productId);
                    const atts = m.attachmentIds ?? [];
                    return (
                      <li key={m.productId} style={{ alignItems: 'flex-start' }}>
                        <span className="xs muted num">{i + 1}</span>
                        <Img icon="tractor" src={p.image ?? undefined} alt="" className="tiny" />
                        <span className="grow stack gap-3" style={{ minWidth: 0 }}>
                          <span className="row gap-2 wrap">
                            <span className="stack gap-0 grow" style={{ minWidth: 0 }}>
                              <span className="small strong truncate">{p.title}</span>
                              <span className="xs muted">{p.shown ? [p.brand, p.price].filter(Boolean).join(' · ') : 'Hidden, suspended or without a live offer: the app leaves it out until it sells again'}</span>
                            </span>
                            {!p.shown && (
                              <Badge tone="warning" icon="eye-off">
                                Not shown
                              </Badge>
                            )}
                          </span>
                          <Field label="Type">
                            <Select id={`df-mt-${i}`} value={m.typeId} disabled={!canEdit} options={[...(d.types.some((t) => t.id === m.typeId) ? [] : [{ value: '', label: 'Pick a type…' }]), ...d.types.map((t) => ({ value: t.id, label: t.name || 'Untitled type' }))]} onChange={(e) => setMachine(i, { typeId: e.target.value })} />
                          </Field>
                          <LinesField id={`df-hl-${i}`} label="Spec lines" hint="Short lines on the machine card, e.g. 25 hp · 4WD or 1.5 m working width" lines={m.highlights ?? []} max={4} placeholder="e.g. 25 hp · 4WD" disabled={!canEdit} onChange={(highlights) => setMachine(i, { highlights })} />
                          <div className="stack gap-2">
                            <span className="label">
                              Attachments <span className="muted">({atts.length} of {MAX_ATTACHMENTS})</span>
                            </span>
                            {atts.length > 0 && (
                              <ul className="list">
                                {atts.map((a) => {
                                  const ai = infoOf(a);
                                  return (
                                    <li key={a}>
                                      <Img icon="package" src={ai.image ?? undefined} alt="" className="tiny" />
                                      <span className="grow stack gap-0" style={{ minWidth: 0 }}>
                                        <span className="small truncate">{ai.title}</span>
                                        <span className="xs muted">{ai.shown ? ai.price : 'Not shown in the store'}</span>
                                      </span>
                                      {canEdit && <IconButton icon="x" label={`Remove attachment ${ai.title}`} onClick={() => setMachine(i, { attachmentIds: atts.filter((x) => x !== a) })} />}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                            {canEdit && atts.length < MAX_ATTACHMENTS && (
                              <div>
                                <Button variant={attachFor === m.productId ? 'soft' : 'secondary'} size="sm" icon="plus" onClick={() => (setAttachFor(attachFor === m.productId ? null : m.productId), document.getElementById('df-q')?.focus())}>
                                  {attachFor === m.productId ? 'Adding attachments: search on the right' : 'Add attachments'}
                                </Button>
                              </div>
                            )}
                          </div>
                        </span>
                        {canEdit && (
                          <span className="stack gap-1">
                            <IconButton icon="arrow-up" label={`Move ${p.title} up`} disabled={i === 0} onClick={() => set({ ...d, machines: moveIn(d.machines, i, -1) ?? d.machines })} />
                            <IconButton icon="arrow-down" label={`Move ${p.title} down`} disabled={i === d.machines.length - 1} onClick={() => set({ ...d, machines: moveIn(d.machines, i, 1) ?? d.machines })} />
                            <IconButton icon="x" label={`Remove ${p.title}`} onClick={() => (set({ ...d, machines: d.machines.filter((x) => x.productId !== m.productId) }), attachFor === m.productId && setAttachFor(null))} />
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          {canEdit && (
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h2 className="h4">{target ? `Attachments for ${infoOf(target.productId).title}` : 'Add machines'}</h2>
                  <span className="xs muted">{target ? 'Products offered with this machine on the order page' : 'Active catalog products'}</span>
                </div>
                {target && (
                  <Button variant="ghost" size="sm" onClick={() => setAttachFor(null)}>
                    Done
                  </Button>
                )}
              </div>
              <div className="card-body stack gap-3">
                <SearchInput id="df-q" placeholder="Search products by name" value={q} onChange={setQ} label="Search products" />
                {term.length < 2 ? (
                  <span className="xs muted">Type at least two letters.</span>
                ) : search.isError ? (
                  <LoadError error={search.error} onRetry={() => void search.refetch()} />
                ) : search.isPending ? (
                  <SkeletonLines rows={3} />
                ) : results.length === 0 ? (
                  <span className="small muted">No products to add for “{term}”.</span>
                ) : (
                  <ul className="list">
                    {results.map((r) => {
                      const info: Info = { title: r.product.title, brand: r.product.brand?.name, image: r.product.images?.[0]?.url, price: r.bestPrice ? formatMoney(r.bestPrice) : null, shown: true };
                      const full = target ? (target.attachmentIds ?? []).length >= MAX_ATTACHMENTS : d.machines.length >= MAX_MACHINES;
                      return (
                        <li key={r.product.id}>
                          <Img icon="package" src={r.product.images?.[0]?.url} alt="" className="tiny" />
                          <span className="grow stack gap-0">
                            <span className="small truncate">{r.product.title}</span>
                            <span className="xs muted">{[r.product.brand?.name, r.bestPrice ? `from ${formatMoney(r.bestPrice)}` : 'No live offer'].filter(Boolean).join(' · ')}</span>
                          </span>
                          <Button
                            variant="secondary"
                            size="sm"
                            icon="plus"
                            disabled={full || (!target && !d.types.length)}
                            onClick={() => {
                              setAdded((a) => ({ ...a, [r.product.id]: info }));
                              if (target) {
                                const i = d.machines.findIndex((m) => m.productId === target.productId);
                                setMachine(i, { attachmentIds: [...(target.attachmentIds ?? []), r.product.id] });
                                announce(`${r.product.title} added as an attachment`);
                              } else {
                                set({ ...d, machines: [...d.machines, { productId: r.product.id, typeId: d.types[0]?.id ?? '', highlights: [], attachmentIds: [] }] });
                                announce(`${r.product.title} added`);
                              }
                            }}
                          >
                            {target ? 'Attach' : 'Add'}
                            <span className="sr-only"> {r.product.title}</span>
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!target && !d.types.length && <span className="xs sub">Add a machine type first: every machine belongs to one.</span>}
              </div>
            </section>
          )}
        </div>
      )}
    </DeptPage>
  );
}
