import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// ⚠️ PASTE YOUR FIREBASE KEYS HERE ⚠️
export const firebaseConfig = {
  apiKey: "AIzaSyDSksHc8RucBx0qW_A6OBP6Ccn1g3hGKKE",
  authDomain: "labelcutter-f7eb6.firebaseapp.com",
  projectId: "labelcutter-f7eb6",
  storageBucket: "labelcutter-f7eb6.firebasestorage.app",
  messagingSenderId: "66842510048",
  appId: "1:66842510048:web:02697d801892172e9d0685",
  measurementId: "G-M42PECLE2Y"
};

let app, auth, db, provider;

if (firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY") {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    provider = new GoogleAuthProvider();
} else {
    console.error("Firebase API Key is missing! Please update firebase-config.js");
}

export { app, auth, db, provider };
