// assets/firebase-init.js
// Paste your Firebase config object here (safe to be public)
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase (compat SDK used for simplicity)
if (!window.firebase) {
  console.error('Firebase SDK not loaded. Add the SDK scripts to your HTML.');
} else {
  firebase.initializeApp(firebaseConfig);
  window.__FB = {
    auth: firebase.auth(),
    db: firebase.firestore(),
    storage: firebase.storage()
  };
}
