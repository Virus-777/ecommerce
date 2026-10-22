import { describe, expect, it } from 'vitest';
import { enabledModules } from '../../modules.config.js';
import { moduleLoaders } from '../../modules/index.js';
import { dependencyProblems, dependentsOf, loadOrder, withDependencies } from './loader.js';

const available = Object.keys(moduleLoaders);

describe('module loader', () => {
  it('accepts the launch configuration', () => {
    expect(dependencyProblems(enabledModules, available)).toEqual([]);
  });

  it('explains which module needs which', () => {
    expect(dependencyProblems(['wishlist', 'customers', 'identity'], available)).toEqual([
      '"wishlist" needs "catalog" (dependsOn), which is not enabled in src/modules.config.ts',
      '"wishlist" needs "offers" (dependsOn), which is not enabled in src/modules.config.ts',
    ]);
    expect(dependencyProblems(['loyalty'], available)[0]).toMatch(/no spec/);
  });

  it('loads dependencies first, and tolerates loops through optional dependencies', () => {
    // identity ⇢ audit ⇢ notifications → identity is a loop with optional edges only
    const order = loadOrder(['identity', 'audit', 'notifications', 'access']);
    expect(order.indexOf('identity')).toBeLessThan(order.indexOf('notifications'));
    expect(order.indexOf('identity')).toBeLessThan(order.indexOf('access'));
    const full = loadOrder(enabledModules);
    expect(full.indexOf('orders')).toBeLessThan(full.indexOf('checkout'));
    expect(full.indexOf('catalog')).toBeLessThan(full.indexOf('offers'));
  });

  it('knows what a module needs and what needs it', () => {
    expect(withDependencies(['cart'])).toEqual(['access', 'cart', 'catalog', 'identity', 'inventory', 'media', 'offers', 'sellers']);
    expect(dependentsOf('payments', enabledModules)).toEqual(['checkout', 'finance', 'food', 'returns', 'software']);
  });
});
