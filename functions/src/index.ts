import {
  beforeUserCreated,
  beforeUserSignedIn,
  HttpsError,
} from 'firebase-functions/v2/identity';

import { isAllowedEmailDomain } from './email-domain.js';

export function enforceAllowedEmail(email: unknown): void {
  if (!isAllowedEmailDomain(email)) {
    throw new HttpsError('permission-denied', 'Only okakam.net accounts are allowed.');
  }
}

export const authBeforeUserCreated = beforeUserCreated((event) => {
  enforceAllowedEmail(event.data?.email);
});

export const authBeforeUserSignedIn = beforeUserSignedIn((event) => {
  enforceAllowedEmail(event.data?.email);
});
