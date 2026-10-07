# resonance

A clean, editorial collaborative music web app with a Spotify-like interaction model built with vanilla HTML/CSS/JavaScript and Firebase Authentication + Cloud Firestore.

**Brand:** resonance — *different platform, same frequency.* The UI uses a Graphite / Midnight Blue base with Bone typography, Merlot primary actions, Olive status accents, and Tobacco highlights.

## What works

- Email/password account creation and sign-in
- Name, unique @handle, and profile picture
- Profile images compressed in-browser and stored in Firestore so the app can stay on Firebase Spark (no Cloud Storage dependency)
- Search people by name or @handle
- Send, accept, decline, and remove friend connections
- Create shared playlists with one or multiple friends
- Real-time playlist updates
- Song search with artwork, title, artist, album, preview, and relevance reranking
- Add songs to shared playlists with visible “Added by” attribution
- Suggest a song to one or multiple friends
- “Recently suggested by friends” home feed
- Choose Spotify, Apple Music, or YouTube Music as the + button destination
- Responsive web UI and mobile navigation
- Firestore security rules and required index included

## Important 2026 Firebase note

Cloud Storage for Firebase requires the Blaze plan. To keep this project compatible with the Spark/no-billing plan, small profile photos are resized to 256×256, compressed in the browser, and stored as a data URL in the user’s Firestore document. Firestore still has a no-cost quota.

## 1) Create Firebase project

1. Create a Firebase project.
2. Add a **Web app**.
3. Enable **Authentication → Sign-in method → Email/Password**.
4. Create a **Cloud Firestore** database. Production mode is fine because you will deploy the rules included here.
5. In `js/firebase-config.js`, paste your Firebase web configuration.

You only need these values:

```js
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "...firebaseapp.com",
  projectId: "...",
  appId: "..."
};
```

## 2) Deploy Firestore rules and index

Install the Firebase CLI if needed:

```bash
npm install -g firebase-tools
firebase login
```

Copy `.firebaserc.example` to `.firebaserc`, replace the project ID, then run:

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

## 3) Run locally

Because this uses browser ES modules, serve the folder rather than opening `index.html` directly.

One easy option:

```bash
npx serve .
```

Then open the local URL it prints.

## 4) Deploy the website to Firebase Hosting

```bash
firebase deploy --only hosting
```

## Music search

The project searches the public iTunes Search API. It needs no developer token and returns track name, artist, album, artwork, Apple link, and preview URL. Results are reranked in the browser to favor exact/prefix title and artist matches.

## About the “+ Music app” button

A browser cannot silently add a track to a user’s Spotify/Apple Music/YouTube Music library without provider-specific authentication and permissions. This app therefore opens the selected provider at the matching track/search, which works immediately without extra credentials.

If you later want **true save-to-library** behavior:

- Spotify: add Spotify OAuth (Authorization Code + PKCE) and call the Spotify Web API for the signed-in Spotify account.
- Apple Music: add MusicKit JS + Apple Developer music token and request library permission.
- YouTube Music: there is no equivalent simple public consumer library API for this exact flow.

The UI is already provider-aware, so you can replace `providerUrl()` in `js/music.js` with a provider authorization/save flow without changing the rest of the app.

## Data model

- `users/{uid}` — public-to-authenticated profile: display name, handle, compressed avatar, provider preference
- `handles/{handleLower}` — atomic unique-handle reservation
- `friendships/{sortedUidPair}` — members, requester, pending/accepted status
- `playlists/{playlistId}` — owner, members, metadata
- `playlists/{playlistId}/songs/{trackKey}` — normalized track + who added it
- `suggestions/{suggestionId}` — sender, recipient, track, timestamp/status

## Security notes

- User emails are kept only in Firebase Authentication and are not written to Firestore.
- Profile photo size is restricted in Firestore rules.
- Playlist tracks can only be read/written by playlist members.
- Friend requests and suggestions validate sender/member identity against Firebase Auth.
- Playlist membership is set at creation in this version. If you add member-management later, update both the UI and rules intentionally.

## Production polish you may want later

- Unique handles are reserved atomically in `handles/{handleLower}` during sign-up
- Spotify/Apple Music OAuth library-save integration
- Push notifications for new friend requests/suggestions
- Invite links
- Playlist cover uploads (would require Blaze/Cloud Storage or a third-party image host)
- Presence/typing-style collaborative indicators
