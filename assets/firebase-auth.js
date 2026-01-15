// assets/firebase-auth.js
// Requires firebase-init.js to have run and window.__FB to exist.

(async function(){
  if(!window.__FB) {
    console.error('Firebase not initialized. Include firebase-init.js first.');
    return;
  }

  const auth = __FB.auth;
  const db = __FB.db;
  const storage = __FB.storage;

  // Providers
  const googleProvider = new firebase.auth.GoogleAuthProvider();
  const githubProvider = new firebase.auth.GithubAuthProvider();

  // Expose simple API for your pages
  window.FBAuth = {
    signInWithGoogle: () => auth.signInWithPopup(googleProvider),
    signInWithGitHub: () => auth.signInWithPopup(githubProvider),
    signOut: () => auth.signOut(),
    currentUser: () => auth.currentUser,
    onAuthStateChanged: (cb) => auth.onAuthStateChanged(cb),
    uploadFileForUser: uploadFileForUser,
    incrementProfileView: incrementProfileView
  };

  // Ensure user doc exists (call after sign-in)
  async function ensureUserDoc(user) {
    if(!user) return;
    const ref = db.collection('users').doc(user.uid);
    await ref.set({
      uid: user.uid,
      name: user.displayName || null,
      email: user.email || null,
      photoURL: user.photoURL || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return ref;
  }

  // Upload file to storage and save metadata in Firestore
  async function uploadFileForUser(file, opts = {}) {
    const user = auth.currentUser;
    if(!user) throw new Error('Not signed in');
    const path = `users/${user.uid}/uploads/${Date.now()}_${file.name}`;
    const ref = storage.ref(path);
    const task = ref.put(file);
    return new Promise((resolve, reject) => {
      task.on('state_changed',
        () => {}, // progress optional
        err => reject(err),
        async () => {
          const url = await ref.getDownloadURL();
          const meta = {
            name: file.name,
            path,
            url,
            size: file.size,
            contentType: file.type,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            ...opts
          };
          await db.collection('users').doc(user.uid).collection('uploads').add(meta);
          resolve(meta);
        }
      );
    });
  }

  // Increment profile view using a transaction (atomic-ish)
  // profileId: string (e.g., 'junjun')
  async function incrementProfileView(profileId) {
    if(!profileId) throw new Error('Missing profileId');
    const statsRef = db.collection('site').doc('globalStats');
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(statsRef);
        if(!snap.exists) {
          tx.set(statsRef, { visitorsByProfile: { [profileId]: 1 } }, { merge: true });
        } else {
          const data = snap.data() || {};
          const map = Object.assign({}, data.visitorsByProfile || {});
          map[profileId] = (map[profileId] || 0) + 1;
          tx.update(statsRef, { visitorsByProfile: map });
        }
      });
      const updated = await statsRef.get();
      return (updated.data().visitorsByProfile || {})[profileId] || 0;
    } catch (e) {
      console.warn('incrementProfileView failed', e);
      throw e;
    }
  }

  // Auto ensure user doc on auth change
  auth.onAuthStateChanged(async user => {
    if(user) await ensureUserDoc(user);
  });

})();
