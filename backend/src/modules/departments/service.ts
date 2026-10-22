import type { DepartmentsPublicApi } from '../../spec/departments.js';
import { DepartmentsExport } from './service/export.js';

export type { DepartmentsServiceDeps } from './service/base.js';

/**
 * Departments use cases: the Phone tab picks, Blogs, Companies, reviews, the Play center and its scores, and the
 * customer's data export (service/*.ts, one area per file on the shared base).
 */
export class DepartmentsService extends DepartmentsExport implements DepartmentsPublicApi {}
