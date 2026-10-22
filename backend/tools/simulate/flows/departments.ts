/**
 * The app's department pages (departments module): a Content Manager writes the sample blog, company and Play center
 * content, adds the phones of the Phone tab (with generated photos), picks the farm machines (departments-data.ts), and adds the providers and
 * services of OS install, Post-sale, Welfare and Booking (services-data.ts) through the Admin Center API; a store
 * visitor then reads each page the way the app does. Only what is missing is added, so a second run changes nothing.
 */
import { seedDepartments } from '../departments-data.js';
import { seedServices } from '../services-data.js';
import type { Sim } from '../sim.js';

export async function departmentsFlow(sim: Sim): Promise<void> {
  const { api, run, world: w } = sim;
  const writer = w.staff.content!;
  const visitor = await sim.people.visitor('store', 'android', 'visitor (departments)');
  await run.attempt('department pages content', async () => {
    const admin = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => api.call(writer.session, method, `/api${path}`, body);
    await seedDepartments(admin, (path) => api.call(visitor, 'GET', `/api${path}`), (file) => sim.upload(writer.session, 'admin', file));
    await seedServices(admin);
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
    const phones = await api.call(visitor, 'GET', '/api/store/departments/phones');
    run.check('the Phone tab lists phones', phones.phones.length > 0, phones);
    const phone = await api.call(visitor, 'GET', `/api/store/departments/phones/${phones.phones[0].slug}`);
    run.check('a phone opens with its photos', phone.photos.length > 0, phone);
    const booking = await api.call(visitor, 'GET', '/api/store/services/providers?area=booking');
    run.check('Booking lists providers', booking.items.length > 0, booking);
    const welfare = await api.call(visitor, 'GET', '/api/store/services/services?area=welfare');
    run.check('Welfare services lists services', welfare.items.length > 0, welfare);
  });
}
