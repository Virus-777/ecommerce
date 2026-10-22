/** Check-ins and the streak, daily tasks (reported by the app and counted from events) and the program switch. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, newId, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const states = (week: any[]) => week.map((d) => `${d.label}:${d.state}`).join(' ');

describe('check-ins', () => {
  it('starts at day 1, counts a streak day by day, gives the bonus on day 7 and starts again after it', async () => {
    const me = newId();
    const fresh = await k.store(me, 'GET', '/summary');
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body).toMatchObject({ balance: 0, streak: 0, checkedInToday: false, todayPoints: 10, bonusLabel: '7 more days to the 100-point bonus on day 7' });
    expect(states(fresh.body.week)).toBe('Today:today Day 2:open Day 3:open Day 4:open Day 5:open Day 6:open Day 7:open');
    expect(fresh.body.week[6]).toMatchObject({ day: 7, points: 100, bonus: true });

    const first = await k.store(me, 'POST', '/check-ins');
    expect(first.status).toBe(201);
    expect(first.body.points).toBe(10);
    expect(first.body.summary).toMatchObject({ balance: 10, streak: 1, checkedInToday: true, bonusLabel: '6 more days to the 100-point bonus on day 7' });
    expect(states(first.body.summary.week)).toBe('Today:done Day 2:open Day 3:open Day 4:open Day 5:open Day 6:open Day 7:open');
    const again = await k.store(me, 'POST', '/check-ins');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_CHECKED_IN');

    const points: number[] = [10];
    for (let day = 2; day <= 8; day++) {
      k.days(1);
      const res = await k.store(me, 'POST', '/check-ins');
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      points.push(res.body.points);
      if (day === 4) expect(res.body.summary).toMatchObject({ streak: 4, bonusLabel: '3 more days to the 100-point bonus on day 7' });
      if (day === 7) {
        expect(res.body.summary.streak).toBe(7);
        expect(res.body.summary.bonusLabel).toBeNull();
        expect(states(res.body.summary.week)).toBe('Day 1:done Day 2:done Day 3:done Day 4:done Day 5:done Day 6:done Today:done');
      }
    }
    // day 8 starts again at day 1
    expect(points).toEqual([10, 10, 15, 15, 20, 20, 100, 10]);
    const history = await k.store(me, 'GET', '/history?limit=3');
    expect(history.body.items.map((e: any) => [e.title, e.points, e.balanceAfter])).toEqual([
      ['Day 1 check-in', 10, 200],
      ['Day 7 check-in bonus', 100, 190],
      ['Day 6 check-in', 20, 90],
    ]);
    expect(history.body.nextCursor).toBeTruthy();
    const more = await k.store(me, 'GET', `/history?limit=10&cursor=${encodeURIComponent(history.body.nextCursor)}`);
    expect(more.body.items).toHaveLength(5);
    k.days(-7);
  });

  it('starts again at day 1 after a missed day', async () => {
    const me = newId();
    await k.store(me, 'POST', '/check-ins');
    k.days(1);
    await k.store(me, 'POST', '/check-ins');
    k.days(2); // a day missed
    const before = await k.store(me, 'GET', '/summary');
    expect(before.body).toMatchObject({ streak: 0, todayPoints: 10, checkedInToday: false });
    expect(before.body.week[0]).toMatchObject({ label: 'Today', state: 'today' });
    const res = await k.store(me, 'POST', '/check-ins');
    expect(res.body).toMatchObject({ points: 10, summary: { streak: 1, balance: 30 } });
    k.days(-3);
  });

  it('follows the schedule staff set, and refuses check-ins and claims while Daily rewards is off', async () => {
    const bad = await k.admin('PUT', '/program', { checkInPoints: [1, 2, 3], enabled: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues[0].path).toBe('checkInPoints');
    expect((await k.admin('PUT', '/program', { checkInPoints: [5, 5, 5, 5, 5, 5, 10_001], enabled: true })).status).toBe(400);
    expect((await k.admin('PUT', '/program', { checkInPoints: [5, 5, 5, 5, 5, 5, 50], enabled: true }, k.staff(['rewards.view']))).status).toBe(403);

    const set = await k.admin('PUT', '/program', { checkInPoints: [5, 5, 5, 5, 5, 5, 50], enabled: false });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ checkInPoints: [5, 5, 5, 5, 5, 5, 50], enabled: false, updatedAt: expect.any(String) });
    expect(k.audits.at(-1)).toMatchObject({ action: 'rewards.program.set', actionLabel: 'Turned Daily rewards off' });
    const me = newId();
    const off = await k.store(me, 'POST', '/check-ins');
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('PROGRAM_OFF');
    expect((await k.store(me, 'GET', '/summary')).body.bonusLabel).toBeNull();

    await k.admin('PUT', '/program', { checkInPoints: [5, 5, 5, 5, 5, 5, 50], enabled: true });
    expect((await k.store(me, 'POST', '/check-ins')).body.points).toBe(5);
    expect((await k.admin('GET', '/program', undefined, k.staff(['rewards.view']))).body.checkInPoints).toEqual([5, 5, 5, 5, 5, 5, 50]);
    await k.admin('PUT', '/program', { checkInPoints: [10, 10, 15, 15, 20, 20, 100], enabled: true });
  });
});

describe('daily tasks', () => {
  beforeAll(async () => {
    for (const t of [
      { kind: 'visit_store', title: 'Visit a store page', points: 5, target: 2, path: '/stores' },
      { kind: 'write_review', title: 'Write a review', points: 30, target: 1, path: '/account/orders' },
      { kind: 'share_product', title: 'Share a product', points: 10, target: 1 },
      { kind: 'place_order', title: 'Place an order', points: 25, target: 1, visible: false },
    ]) {
      const res = await k.admin('POST', '/tasks', t);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
  });

  it('counts reported visits once per refId a day up to the target, then the points are claimed once', async () => {
    const me = newId();
    const one = await k.store(me, 'POST', '/tasks/visit-a-store-page/progress', { refId: 'virus-store' });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body).toMatchObject({ key: 'visit-a-store-page', kind: 'visit_store', progress: 1, target: 2, state: 'todo', path: '/stores' });
    expect((await k.store(me, 'POST', '/tasks/visit-a-store-page/progress', { refId: 'virus-store' })).body.progress).toBe(1);
    const notYet = await k.store(me, 'POST', '/tasks/visit-a-store-page/claim');
    expect(notYet.status).toBe(409);
    expect(notYet.body.error).toMatchObject({ code: 'TASK_NOT_DONE', details: { progress: 1, target: 2 } });
    expect((await k.store(me, 'POST', '/tasks/visit-a-store-page/progress', { refId: 'casa-verde' })).body).toMatchObject({ progress: 2, state: 'ready' });
    expect((await k.store(me, 'POST', '/tasks/visit-a-store-page/progress', { refId: 'northwind' })).body.progress).toBe(2);

    const claimed = await k.store(me, 'POST', '/tasks/visit-a-store-page/claim');
    expect(claimed.status).toBe(200);
    expect(claimed.body.balance).toBe(5);
    expect(claimed.body.tasks.map((t: any) => `${t.key}:${t.state}`)).toEqual(['visit-a-store-page:claimed', 'write-a-review:todo', 'share-a-product:todo']);
    const twice = await k.store(me, 'POST', '/tasks/visit-a-store-page/claim');
    expect(twice.body.error.code).toBe('ALREADY_CLAIMED');
    expect((await k.store(me, 'GET', '/history')).body.items[0]).toMatchObject({ kind: 'task', title: 'Visit a store page', points: 5, balanceAfter: 5 });
    expect((await k.admin('GET', '/tasks')).body.find((t: any) => t.key === 'visit-a-store-page').claimedToday).toBeGreaterThanOrEqual(1);

    // tasks reset at midnight (market time)
    k.days(1);
    expect((await k.store(me, 'GET', '/summary')).body.tasks[0]).toMatchObject({ progress: 0, state: 'todo' });
    k.days(-1);
  });

  it('refuses reports of tasks that count themselves, and unknown or hidden tasks', async () => {
    const me = newId();
    const review = await k.store(me, 'POST', '/tasks/write-a-review/progress', {});
    expect(review.status).toBe(409);
    expect(review.body.error.code).toBe('NOT_REPORTABLE');
    expect((await k.store(me, 'POST', '/tasks/nope/progress', {})).status).toBe(404);
    expect((await k.store(me, 'POST', '/tasks/place-an-order/progress', {})).status).toBe(404);
    expect((await k.store(me, 'POST', '/tasks/nope/claim')).status).toBe(404);
  });

  it('counts a published review by its author once, and placed orders once each when the task is shown', async () => {
    const me = newId();
    const customerId = k.customerOf(me);
    const review = { reviewId: newId(), productId: newId(), sellerId: newId(), customerId, rating: 5, verified: true };
    await k.publish('reviews.review.published', review);
    await k.publish('reviews.review.published', { ...review, rating: 4 }); // edited: the same review
    await k.publish('reviews.review.published', { ...review, reviewId: newId(), customerId: null });
    const summary = (await k.store(me, 'GET', '/summary')).body;
    expect(summary.tasks.find((t: any) => t.key === 'write-a-review')).toMatchObject({ progress: 1, state: 'ready' });
    expect((await k.store(me, 'POST', '/tasks/write-a-review/claim')).body.balance).toBe(30);

    const order = (orderId: string) => ({ orderId, ref: 'MK-300107-00001', checkoutSessionId: newId(), customerId, guestEmail: null, paymentIntentId: newId(), paymentState: 'accepted', total: { amount: 5000, currency: 'USD' }, couponCodes: [], groups: [], placedAt: k.clock.now().toISOString(), attemptNo: 1, contactName: 'Sam' });
    await k.publish('orders.order.placed', order(newId())); // hidden task: not counted
    await k.admin('PATCH', '/tasks/place-an-order', { kind: 'place_order', title: 'Place an order', points: 25, target: 2, visible: true });
    const orderId = newId();
    await k.publish('orders.order.placed', order(orderId));
    await k.publish('orders.order.placed', order(orderId));
    expect((await k.store(me, 'GET', '/summary')).body.tasks.find((t: any) => t.key === 'place-an-order')).toMatchObject({ progress: 1, target: 2, state: 'todo' });
    await k.admin('PATCH', '/tasks/place-an-order', { kind: 'place_order', title: 'Place an order', points: 25, target: 1, visible: false });
  });

  it('keeps the task list: keys from titles, SLUG_TAKEN, validation, reorder and delete', async () => {
    const dup = await k.admin('POST', '/tasks', { kind: 'share_product', title: 'Share a product', points: 10, target: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SLUG_TAKEN');
    const bad = await k.admin('POST', '/tasks', { kind: 'share_product', title: 'Share twice', points: 0, target: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues[0].path).toBe('points');
    expect((await k.admin('POST', '/tasks', { kind: 'share_product', title: 'Share twice', points: 10, target: 21 })).status).toBe(400);
    const made = await k.admin('POST', '/tasks', { kind: 'share_product', key: 'share-2', title: 'Share two products', points: 15, target: 2, position: 0 });
    expect(made.body).toMatchObject({ key: 'share-2', position: 0, visible: true, claimedToday: 0 });
    expect((await k.admin('GET', '/tasks')).body[0].key).toBe('share-2');
    expect((await k.admin('DELETE', '/tasks/share-2')).status).toBe(204);
    expect((await k.admin('DELETE', '/tasks/share-2')).status).toBe(404);
    expect(k.audits.map((a) => a.action)).toEqual(expect.arrayContaining(['rewards.task.create', 'rewards.task.update', 'rewards.task.delete']));
  });
});
