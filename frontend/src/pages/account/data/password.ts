// Accounts without a password (Google or Apple sign-in): SecurityOverview.hasPassword is false and actions that
// confirm with a password answer 409 PASSWORD_NOT_SET (not counted as a failure). There is no set-password flow
// yet (G12/G28), so the security and profile screens disable those actions and say why.
import { ApiError } from '@marketly/web-shared/api';

export const NO_PASSWORD_NOTE = 'Your account signs in without a password (Google or Apple), so actions that confirm with a password aren’t available.';

export const isPasswordNotSet = (e: unknown) => e instanceof ApiError && e.code === 'PASSWORD_NOT_SET';
