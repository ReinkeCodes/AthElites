import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyAYUJMODQYqlvCxxg2v1hFGO5LldwInqng",
  authDomain: "athelites-c32e5.firebaseapp.com",
  projectId: "athelites-c32e5",
  storageBucket: "athelites-c32e5.firebasestorage.app",
  messagingSenderId: "772411679538",
  appId: "1:772411679538:web:0183ec14ca55a3888eed2b"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
