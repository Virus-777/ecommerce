import type { DepartmentsPublicApi } from '../../spec/departments.js';
import { DepartmentsPlay } from './service/play.js';

export type { DepartmentsServiceDeps } from './service/base.js';

/**
 * Departments use cases: the Phone tab picks, Blogs, Companies and the Play center (service/*.ts, one area per
 * file on the shared base). The module has no public API yet; everything is reached through its HTTP endpoints.
 */
export class DepartmentsService extends DepartmentsPlay implements DepartmentsPublicApi {}
