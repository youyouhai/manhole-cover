import cloudbase from '@cloudbase/js-sdk';

const env = process.env.NEXT_PUBLIC_CLOUDBASE_ENV_ID;

if (!env) {
  throw new Error('CloudBase browser configuration is incomplete');
}

export const cloudbaseApp = cloudbase.init({
  env,
  region: 'ap-shanghai',
  auth: { detectSessionInUrl: true },
});

// Keep credentials only for the current browser session. Closing the browser
// returns the operator to the email/password gate on the next visit.
export const cloudbaseAuth = cloudbaseApp.auth({ persistence: 'session' });
