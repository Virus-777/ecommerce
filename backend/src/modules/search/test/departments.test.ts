/**
 * Integrated search: the fan-out to the department modules, how their sections are ranked against each other, the
 * shortcut card for a department the query names, a department's own paged list, and what happens when a module is
 * off, fails or is too slow.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { notImplemented } from '../../../kernel/errors/index.js';
import { scoreOf } from '../../../kernel/lib/dept-search.js';
import type * as common from '../../../spec/common.js';
import { departmentsNamed, modulesFor } from '../domain/departments.js';
import { boot, STORE, type Kit } from './helpers.js';

let kit: Kit | undefined;
afterEach(async () => {
  await kit?.close();
  kit = undefined;
});

type Call = { module: string; input: common.DeptSearchRequest };

const hit = (kind: string, title: string, score: number, extra: Partial<common.DeptSearchHit> = {}): common.DeptSearchHit => ({
  id: `${kind}-${title}`,
  kind,
  title,
  meta: null,
  sub: null,
  image: null,
  badge: null,
  badgeTone: null,
  priceLabel: null,
  wasLabel: null,
  path: `/${kind}/${title}`,
  score,
  ...extra,
});

const group = (kind: string, title: string, items: common.DeptSearchHit[], extra: Partial<common.DeptSearchGroup> = {}): common.DeptSearchGroup => ({
  kind,
  title,
  total: items.length,
  items,
  nextCursor: null,
  ...extra,
});

/**
 * Boots search with the five department modules stubbed. `answers` says what each one sends back; a module whose
 * answer is a function may throw, hang or look at what it was asked.
 */
async function bootWith(
  answers: Partial<Record<'departments' | 'software' | 'services' | 'food' | 'rewards', common.DeptSearchGroup[] | ((input: common.DeptSearchRequest) => Promise<common.DeptSearchResult>)>>,
  o: { settings?: Record<string, unknown>; calls?: Call[] } = {},
): Promise<Kit> {
  const fn = (module: string) => async (input: common.DeptSearchRequest) => {
    o.calls?.push({ module, input });
    const answer = answers[module as keyof typeof answers];
    if (!answer) return { groups: [] };
    return typeof answer === 'function' ? answer(input) : { groups: answer };
  };
  kit = await boot({
    ...(o.settings ? { settings: o.settings } : {}),
    stubs: {
      departments: { searchDepartments: fn('departments') },
      software: { searchSoftware: fn('software') },
      services: { searchServices: fn('services') },
      food: { searchFood: fn('food') },
      rewards: { searchRewards: fn('rewards') },
    },
  });
  return kit;
}

describe('the match score', () => {
  it('reads the same everywhere: equal, starts with, a word starts with, contains, a secondary field', () => {
    expect(scoreOf('napoli pizza', 'Napoli Pizza')).toBe(100);
    expect(scoreOf('napoli', 'Napoli Pizza')).toBe(85);
    expect(scoreOf('pizza', 'Napoli Pizza')).toBe(70);
    expect(scoreOf('oli piz', 'Napoli Pizza')).toBe(55);
    expect(scoreOf('italian', 'Napoli Pizza', ['Pizza · Italian'])).toBe(35);
    expect(scoreOf('sushi', 'Napoli Pizza', ['Pizza · Italian'])).toBe(0);
    expect(scoreOf('  NAPOLI   pizza ', 'napoli pizza')).toBe(100);
  });
});

describe('the departments a query names', () => {
  it('names a department by its own words, not inside a product query', () => {
    expect(departmentsNamed('food delivery').map((d) => d.key)).toEqual(['food']);
    expect(departmentsNamed('food').map((d) => d.key)).toEqual(['food']);
    expect(departmentsNamed('daily rewards').map((d) => d.key)).toEqual(['rewards']);
    expect(departmentsNamed('food processor').map((d) => d.key)).toEqual([]);
    expect(departmentsNamed('headphones').map((d) => d.key)).toEqual([]);
  });

  it('asks each module once, whatever sections it answers for', () => {
    expect(modulesFor(['phones', 'farm', 'blogs', 'food'])).toEqual([
      { module: 'departments', sections: ['phones', 'farm', 'blogs'] },
      // the Phones section is also the OS install and Post-sale services
      { module: 'services', sections: ['phones'] },
      { module: 'food', sections: ['food'] },
    ]);
  });
});

describe('GET /departments', () => {
  it('ranks the sections by their best match, then by size, then by the rail order', async () => {
    const k = await bootWith({
      food: [group('restaurant', 'Restaurants', [hit('restaurant', 'Pizza Palace', 85), hit('restaurant', 'Slice House', 35)])],
      departments: [
        group('post', 'Posts', [hit('post', 'Best pizza dough', 55)]),
        group('company', 'Companies', [hit('company', 'Pizza Co.', 100)]),
      ],
      software: [group('app', 'Apps', [hit('app', 'Pizza Timer', 55)])],
    });
    const res = await k.call('GET', `${STORE}/departments?q=pizza`, k.visitor);
    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(false);
    // companies 100 · food 85 · softwares and blogs both 55, softwares first (the rail's order)
    expect(res.body.sections.map((s: any) => s.key)).toEqual(['companies', 'food', 'software', 'blogs']);
    expect(res.body.sections[0]).toMatchObject({ key: 'companies', name: 'Companies', icon: 'building-2', path: '/companies', total: 1 });
    expect(res.body.total).toBe(5);
    expect(res.body.shortcuts).toEqual([]);
  });

  it('lays a section out in the screen order of its groups, and keeps each group together', async () => {
    const k = await bootWith({
      departments: [
        group('topic', 'Topics', [hit('topic', 'Pizza', 100)]),
        group('post', 'Posts', [hit('post', 'Pizza dough', 85)]),
      ],
    });
    const { body } = await k.call('GET', `${STORE}/departments?q=pizza`, k.visitor);
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0].groups.map((g: any) => g.kind)).toEqual(['post', 'topic']);
  });

  it('answers a department the query names with a shortcut when it has no matching record', async () => {
    const k = await bootWith({});
    const { body } = await k.call('GET', `${STORE}/departments?q=daily%20rewards`, k.visitor);
    expect(body.sections).toEqual([]);
    expect(body.shortcuts).toEqual([
      { key: 'rewards', name: 'Daily rewards', icon: 'gift', path: '/rewards', tagline: 'Check in every day and swap points for coupons' },
    ]);
  });

  it('leaves the shortcut out when that department answered with records of its own', async () => {
    const k = await bootWith({ food: [group('restaurant', 'Restaurants', [hit('restaurant', 'Food Hall', 85)])] });
    const { body } = await k.call('GET', `${STORE}/departments?q=food`, k.visitor);
    expect(body.sections.map((s: any) => s.key)).toEqual(['food']);
    expect(body.shortcuts).toEqual([]);
  });

  it('asks every module at once with the typed text and the section limit', async () => {
    const calls: Call[] = [];
    const k = await bootWith({}, { calls, settings: { departmentSectionLimit: 2 } });
    await k.call('GET', `${STORE}/departments?q=pizza`, k.visitor);
    expect(calls.map((c) => c.module).sort()).toEqual(['departments', 'food', 'rewards', 'services', 'software']);
    expect(calls.every((c) => c.input.q === 'pizza' && c.input.limit === 2)).toBe(true);
    expect(calls.find((c) => c.module === 'services')!.input.sections).toEqual(['phones', 'welfare', 'booking']);
    expect(calls.find((c) => c.module === 'food')!.input.sections).toEqual(['food']);
    expect(calls.find((c) => c.module === 'departments')!.input.sections).toEqual(['phones', 'farm', 'blogs', 'companies', 'play']);
  });

  it('a module that is not built yet is simply absent, and the answer is not partial', async () => {
    const k = await bootWith({
      food: async () => {
        throw notImplemented('food');
      },
      software: [group('app', 'Apps', [hit('app', 'Pizza Timer', 70)])],
    });
    const { body } = await k.call('GET', `${STORE}/departments?q=pizza`, k.visitor);
    expect(body.sections.map((s: any) => s.key)).toEqual(['software']);
    expect(body.partial).toBe(false);
  });

  it('a module that fails is left out and the answer is partial', async () => {
    const k = await bootWith({
      food: async () => {
        throw new Error('restaurants are down');
      },
      software: [group('app', 'Apps', [hit('app', 'Pizza Timer', 70)])],
    });
    const { body } = await k.call('GET', `${STORE}/departments?q=pizza`, k.visitor);
    expect(body.sections.map((s: any) => s.key)).toEqual(['software']);
    expect(body.partial).toBe(true);
  });

  it('a module that takes too long is left out and the answer is partial', async () => {
    const k = await bootWith(
      {
        food: () => new Promise((resolve) => setTimeout(() => resolve({ groups: [group('restaurant', 'Restaurants', [hit('restaurant', 'Late Pizza', 85)])] }), 300)),
        software: [group('app', 'Apps', [hit('app', 'Pizza Timer', 70)])],
      },
      { settings: { departmentFanoutTimeoutMs: 40 } },
    );
    const { body } = await k.call('GET', `${STORE}/departments?q=pizza`, k.visitor);
    expect(body.sections.map((s: any) => s.key)).toEqual(['software']);
    expect(body.partial).toBe(true);
  });

  it('answers nothing while the setting is off, and for an empty query', async () => {
    const calls: Call[] = [];
    const off = await bootWith({ food: [group('restaurant', 'Restaurants', [hit('restaurant', 'Pizza Palace', 85)])] }, { calls, settings: { departmentSearch: false } });
    const { body } = await off.call('GET', `${STORE}/departments?q=pizza`, off.visitor);
    expect(body).toMatchObject({ sections: [], shortcuts: [], total: 0, partial: false });
    expect(calls).toEqual([]);
    await off.close();
    kit = undefined;

    const on = await bootWith({ food: [group('restaurant', 'Restaurants', [hit('restaurant', 'Pizza Palace', 85)])] }, { calls });
    const empty = await on.call('GET', `${STORE}/departments?q=%20`, on.visitor);
    expect(empty.body.sections).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('leaves out a group with no hits and a kind no department owns', async () => {
    const k = await bootWith({
      food: [group('restaurant', 'Restaurants', []), group('dish', 'Dishes', [hit('dish', 'Pizza', 100)])],
      software: [group('something_else', 'Unknown', [hit('something_else', 'Pizza', 100)])],
    });
    const { body } = await k.call('GET', `${STORE}/departments?q=pizza`, k.visitor);
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0].groups.map((g: any) => g.kind)).toEqual(['dish']);
  });
});

describe('GET /departments/{key}', () => {
  it('answers one department with the scope limit, and pages one group by its cursor', async () => {
    const calls: Call[] = [];
    const k = await bootWith(
      {
        food: async (input) => ({
          groups: [group('dish', 'Dishes', [hit('dish', input.cursor ? 'Pizza fritta' : 'Margherita', 85)], { total: 2, nextCursor: input.cursor ? null : 'MQ' })],
        }),
      },
      { calls, settings: { departmentScopeLimit: 5 } },
    );
    const first = await k.call('GET', `${STORE}/departments/food?q=pizza`, k.visitor);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ key: 'food', name: 'Food delivery', icon: 'utensils', path: '/food', total: 2 });
    expect(first.body.groups[0]).toMatchObject({ kind: 'dish', nextCursor: 'MQ' });
    expect(calls.at(-1)!.input).toMatchObject({ q: 'pizza', limit: 5 });

    const more = await k.call('GET', `${STORE}/departments/food?q=pizza&kind=dish&cursor=MQ`, k.visitor);
    expect(more.body.groups[0].items.map((i: any) => i.title)).toEqual(['Pizza fritta']);
    expect(calls.at(-1)!.input).toMatchObject({ kinds: ['dish'], cursor: 'MQ' });
    expect(calls.every((c) => c.module === 'food')).toBe(true);
  });

  it('is NOT_FOUND for anything that is not a department', async () => {
    const k = await bootWith({});
    const res = await k.call('GET', `${STORE}/departments/groceries?q=pizza`, k.visitor);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('answers an empty section for a kind that department has not got', async () => {
    const calls: Call[] = [];
    const k = await bootWith({ food: [group('dish', 'Dishes', [hit('dish', 'Margherita', 85)])] }, { calls });
    const res = await k.call('GET', `${STORE}/departments/food?q=pizza&kind=app`, k.visitor);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'food', total: 0, groups: [] });
    expect(calls).toEqual([]);
  });
});

describe('suggestions while typing', () => {
  it('carry a group per department with matches, at most departmentSuggestLimit hits each', async () => {
    const k = await bootWith(
      {
        food: [group('restaurant', 'Restaurants', [hit('restaurant', 'Napoli Pizza', 85), hit('restaurant', 'Slice House', 55)]), group('dish', 'Dishes', [hit('dish', 'Margherita', 70)])],
        departments: [group('post', 'Posts', [hit('post', 'Best pizza dough', 55)])],
      },
      { settings: { departmentSuggestLimit: 2 } },
    );
    const { body } = await k.call('GET', `${STORE}/suggestions?q=piz`, k.visitor);
    expect(body.departments.map((d: any) => d.key)).toEqual(['food', 'blogs']);
    expect(body.departments[0]).toMatchObject({ name: 'Food delivery', icon: 'utensils', path: '/food', total: 3 });
    expect(body.departments[0].items.map((i: any) => i.title)).toEqual(['Napoli Pizza', 'Margherita']);
    expect(body.departments[1].items).toHaveLength(1);
  });

  it('are empty with nothing typed', async () => {
    const k = await bootWith({ food: [group('restaurant', 'Restaurants', [hit('restaurant', 'Napoli Pizza', 85)])] });
    const { body } = await k.call('GET', `${STORE}/suggestions?q=%20`, k.visitor);
    expect(body.departments).toEqual([]);
  });
});
