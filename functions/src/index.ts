import {
  beforeUserCreated,
  beforeUserSignedIn,
  HttpsError,
} from 'firebase-functions/v2/identity';

import { isAllowedEmailDomain } from './email-domain.js';

/** Cloud Run・Firestore・GCSと同じ東京リージョンにdeployする。 */
export const FUNCTION_REGION = 'asia-northeast1';

export function enforceAllowedEmail(email: unknown): void {
  if (!isAllowedEmailDomain(email)) {
    throw new HttpsError('permission-denied', 'email domain is not allowed');
  }
}

export const authBeforeUserCreated = beforeUserCreated({ region: FUNCTION_REGION }, (event) => {
  enforceAllowedEmail(event.data?.email);
});

export const authBeforeUserSignedIn = beforeUserSignedIn({ region: FUNCTION_REGION }, (event) => {
  enforceAllowedEmail(event.data?.email);
});
