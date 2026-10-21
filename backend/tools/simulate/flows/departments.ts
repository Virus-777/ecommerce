/**
 * The app's department pages (departments module): a Content Manager writes the sample blog, company and Play center
 * content and picks the phones of the Phone tab through the Admin Center API (departments-data.ts); a store visitor
 * then reads each page the way the app does. Only what is missing is added, so a second run changes nothing.
 */
import { seedDepartments } from '../departments-data.js';
import type { Sim } from '../sim.js';

export async function departmentsFlow(sim: Sim): Promise<void> {
  const { api, run, world: w } = sim;
  const writer = w.staff.content!;
  const visitor = await sim.people.visitor('store', 'android', 'visitor (departments)');
  await run.attempt('department pages content', async () => {
    await seedDepartments(
      (method, path, body) => api.call(writer.session, method, `/api${path}`, body),
      (path) => api.call(visitor, 'GET', `/api${path}`),
    );
  });
  await run.attempt('department pages in the app', async () => {
    const posts = await api.call(visitor, 'GET', '/api/store/departments/blogs/posts');
    run.check('the blog lists published posts', posts.items.length > 0, posts);
    const post = await api.call(visitor, 'GET', `/api/store/departments/blogs/posts/${posts.items[0].slug}`);
    run.check('a post opens with its body', typeof post.body === 'string' && post.body.length > 0, post);
    const companies = await api.call(visitor, 'GET', '/api/store/departments/companies');
    run.check('the Companies page lists companies', companies.items.length > 0, companies);
    const games = await api.call(visitor, 'GET', '/api/store/departments/play/games');
    run.check('the Play center lists games', games.games.length > 0, games);
    const rankings = await api.call(visitor, 'GET', '/api/store/departments/play/rankings');
    run.check('the weekly rankings have rows', rankings.entries.length > 0, rankings);
    await api.call(visitor, 'GET', '/api/store/departments/phones');
  });
}
