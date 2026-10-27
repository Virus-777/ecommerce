import type { DepartmentsPublicApi } from '../../spec/departments.js';
import { DepartmentsSearch } from './service/search.js';

export type { DepartmentsServiceDeps } from './service/base.js';

/**
 * Departments use cases: the Phone tab's phones, Blogs, Companies, reviews, the Play center and its scores, the
 * customer's data export and these departments' part of the integrated search (service/*.ts, one area per file on
 * the shared base).
 */
export class DepartmentsService extends DepartmentsSearch implements DepartmentsPublicApi {}
