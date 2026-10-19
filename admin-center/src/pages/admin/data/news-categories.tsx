import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { Alert, announce, Badge, Button, Dialog, Field, Icon, IconButton, Select, StatusBadge, Switch, TextInput } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines } from '@/app/parts';
import { CATEGORY_ICONS, CATEGORY_NAME_MAX, categoryIcon, STATUS_LABEL, type NewsCategory, type NewsStatus } from './news';

// News › Manage categories (designed in React from docs/06-news.md §2 and §4): GET /api/admin/content/news-categories
// (hidden ones too), POST to add, PATCH /{id} to rename, change the icon, show or hide, or move (position), DELETE an
// unused one (CONFLICT lists the posts that use it in details.posts). No review step; changes are audited.

type ConflictPost = { id: string; title: string; status: NewsStatus };
const ICON_OPTIONS = [{ value: '', label: 'No icon' }, ...CATEGORY_ICONS];

export const NEWS_CATEGORIES_KEY = ['content', 'news-categories'] as const;

export function NewsCategoriesDialog({ open, canEdit, onClose, onOpenPost }: { open: boolean; canEdit: boolean; onClose: () => void; onOpenPost: (id: string) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: NEWS_CATEGORIES_KEY, enabled: open, queryFn: () => call(api.GET('/api/admin/content/news-categories')) });
  const list = [...(cats.data ?? [])].sort((a, b) => a.position - b.position);

  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [add, setAdd] = useState({ name: '', icon: '' });
  const [addTried, setAddTried] = useState(false);
  const [blocked, setBlocked] = useState<{ name: string; message: string; posts: ConflictPost[] } | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: NEWS_CATEGORIES_KEY });
    void qc.invalidateQueries({ queryKey: ['content', 'news'] });
  };

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; icon?: string | null; visible?: boolean; position?: number }; say: string }) =>
      call(api.PATCH('/api/admin/content/news-categories/{id}', { params: { path: { id }, }, body })),
    onSuccess: (_c, { say }) => {
      setEditing(null);
      setBlocked(null);
      refresh();
      announce(say);
    },
  });
  const create = useMutation({
    mutationFn: () => call(api.POST('/api/admin/content/news-categories', { body: { name: add.name.trim(), icon: add.icon || null, visible: true } })),
    onSuccess: (c) => {
      setAdd({ name: '', icon: '' });
      setAddTried(false);
      setBlocked(null);
      refresh();
      announce(`Category ${c.name} added`);
    },
  });
  const remove = useMutation({
    mutationFn: (c: NewsCategory) => call(api.DELETE('/api/admin/content/news-categories/{id}', { params: { path: { id: c.id } } })),
    onSuccess: (_r, c) => {
      setBlocked(null);
      refresh();
      announce(`Category ${c.name} deleted`);
    },
    onError: (e, c) => {
      if (e instanceof ApiError && e.status === 409 && Array.isArray(e.details.posts)) setBlocked({ name: c.name, message: e.message, posts: e.details.posts as ConflictPost[] });
    },
  });

  const busy = update.isPending || create.isPending || remove.isPending;
  const failure = update.error ?? create.error ?? (blocked ? null : remove.error);
  const addError = addTried && !add.name.trim() ? 'Enter a name.' : create.error instanceof ApiError ? create.error.fieldErrors.name : undefined;
  const renameError = update.error instanceof ApiError ? update.error.fieldErrors.name : undefined;

  const move = (c: NewsCategory, by: -1 | 1) => update.mutate({ id: c.id, body: { position: c.position + by }, say: `${c.name} moved ${by < 0 ? 'up' : 'down'}` });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="News categories"
      size="lg"
      foot={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="small sub">Categories are the filter chips on the store’s News page, in this order. Hiding one removes its chip; its posts stay listed under All.</p>
      {failure && !addError && !renameError && <Alert tone="danger" title={errorMessage(failure)} />}
      {blocked && (
        <Alert tone="warning" title={`${blocked.name} is still in use`}>
          <span className="stack gap-1">
            <span>{blocked.message}</span>
            <span className="stack gap-1">
              {blocked.posts.map((p) => (
                <span key={p.id} className="row gap-2">
                  <button type="button" className="btn btn-link small" onClick={() => onOpenPost(p.id)}>
                    {p.title}
                  </button>
                  <StatusBadge status={STATUS_LABEL[p.status] ?? p.status} />
                </span>
              ))}
            </span>
          </span>
        </Alert>
      )}
      {cats.isError ? (
        <LoadError error={cats.error} onRetry={() => void cats.refetch()} />
      ) : cats.isPending ? (
        <SkeletonLines rows={4} />
      ) : (
        <ul className="list nw-cats" aria-label="Categories">
          {list.map((c, i) => (
            <li key={c.id}>
              <span className="nw-cat-ic" aria-hidden="true">
                <Icon name={categoryIcon(c.icon)} />
              </span>
              <span className="stack gap-1 grow min-w-0">
                {editing?.id === c.id ? (
                  <span className="row gap-2">
                    <TextInput
                      id={`nc-name-${c.id}`}
                      aria-label={`New name for ${c.name}`}
                      value={editing.name}
                      maxLength={CATEGORY_NAME_MAX}
                      error={!!renameError}
                      onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && editing.name.trim()) update.mutate({ id: c.id, body: { name: editing.name.trim() }, say: `Renamed to ${editing.name.trim()}` });
                        if (e.key === 'Escape') (e.stopPropagation(), setEditing(null));
                      }}
                      autoFocus
                    />
                    <Button size="sm" onClick={() => update.mutate({ id: c.id, body: { name: editing.name.trim() }, say: `Renamed to ${editing.name.trim()}` })} disabled={busy || !editing.name.trim() || editing.name.trim() === c.name}>
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => (update.reset(), setEditing(null))}>
                      Cancel
                    </Button>
                    {renameError && <span className="xs t-danger-text">{renameError}</span>}
                  </span>
                ) : (
                  <span className="row gap-2">
                    <span className="small strong">{c.name}</span>
                    {!c.visible && <Badge icon="eye-off">Hidden</Badge>}
                    {canEdit && <IconButton icon="pencil" label={`Rename ${c.name}`} size="sm" onClick={() => (update.reset(), setEditing({ id: c.id, name: c.name }))} disabled={busy} />}
                  </span>
                )}
                <span className="xs muted">
                  {c.postCount} published {c.postCount === 1 ? 'post' : 'posts'} · /news?category={c.slug}
                </span>
              </span>
              {canEdit ? (
                <span className="row gap-2 nw-cat-ctl">
                  <Select
                    id={`nc-icon-${c.id}`}
                    ctl="sm"
                    aria-label={`Icon for ${c.name}`}
                    options={ICON_OPTIONS}
                    value={c.icon && ICON_OPTIONS.some((o) => o.value === c.icon) ? c.icon : ''}
                    onChange={(e) => update.mutate({ id: c.id, body: { icon: e.target.value || null }, say: `${c.name} icon changed` })}
                    disabled={busy}
                  />
                  <Switch
                    id={`nc-vis-${c.id}`}
                    label={c.visible ? 'Visible' : 'Hidden'}
                    labelClassName="xs"
                    checked={c.visible}
                    onChange={(e) => update.mutate({ id: c.id, body: { visible: e.target.checked }, say: `${c.name} ${e.target.checked ? 'shown' : 'hidden'}` })}
                    disabled={busy}
                  />
                  <IconButton icon="arrow-up" label={`Move ${c.name} up`} size="sm" onClick={() => move(c, -1)} disabled={busy || i === 0} />
                  <IconButton icon="arrow-down" label={`Move ${c.name} down`} size="sm" onClick={() => move(c, 1)} disabled={busy || i === list.length - 1} />
                  <IconButton icon="trash-2" label={`Delete ${c.name}`} size="sm" onClick={() => (setBlocked(null), remove.mutate(c))} disabled={busy} />
                </span>
              ) : null}
            </li>
          ))}
          {list.length === 0 && <li className="small muted">No categories yet. Add the first one below.</li>}
        </ul>
      )}
      {canEdit && (
        <form
          className="nw-cat-add"
          onSubmit={(e) => {
            e.preventDefault();
            setAddTried(true);
            if (add.name.trim()) create.mutate();
          }}
        >
          <Field label="New category" hint={`Up to ${CATEGORY_NAME_MAX} characters, e.g. Service updates`} error={addError}>
            <TextInput id="nc-new" value={add.name} maxLength={CATEGORY_NAME_MAX} error={!!addError} onChange={(e) => (create.reset(), setAdd((a) => ({ ...a, name: e.target.value })))} />
          </Field>
          <Field label="Icon">
            <Select id="nc-new-icon" options={ICON_OPTIONS} value={add.icon} onChange={(e) => setAdd((a) => ({ ...a, icon: e.target.value }))} />
          </Field>
          <Button type="submit" variant="secondary" icon="plus" disabled={busy}>
            Add category
          </Button>
        </form>
      )}
    </Dialog>
  );
}
