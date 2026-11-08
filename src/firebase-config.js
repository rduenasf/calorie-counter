// Firebase web config, read from VITE_FIREBASE_* at build time (.env.local for dev,
// repository variables for the GitHub Pages build). These values are public by design:
// what keeps the data private is sign-in plus the Firestore rules in firestore.rules.
// Without them the app runs exactly as before, local-only, and Settings shows no sync.

const env = import.meta.env;

export const firebaseConfig = env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID
  ? {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    }
  : null;
