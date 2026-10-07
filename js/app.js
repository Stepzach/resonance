import {
  auth, db,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile,
  doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, writeBatch, runTransaction, deleteUser,
} from "./firebase.js";
import { searchSongs, providerUrl, trackKey } from "./music.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const state = {
  user: null,
  profile: null,
  profiles: new Map(),
  friendships: [],
  friends: [],
  playlists: [],
  currentPlaylist: null,
  currentPlaylistSongs: [],
  suggestionTargets: new Set(),
  previewingUrl: "",
  unsubscribers: [],
  playlistSongsUnsub: null,
};

const placeholderAvatar = (seed = "U") => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="100%" height="100%" fill="#1C2430"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#E6E0D6" font-family="Arial" font-size="52" font-weight="700">${(seed[0] || "U").toUpperCase()}</text></svg>`)}`;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));
}
function toast(message, type = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "error" : ""}`;
  el.textContent = message;
  $("#toast-root").append(el);
  setTimeout(() => el.remove(), 3300);
}
function friendlyError(error) {
  const code = error?.code || "";
  const map = {
    "auth/email-already-in-use": "That email already has an account.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/weak-password": "Use a password with at least 6 characters.",
    "auth/invalid-email": "Enter a valid email address.",
    "permission-denied": "Firebase blocked that action. Check your deployed Firestore rules.",
  };
  return map[code] || error?.message?.replace(/^Firebase:\s*/i, "") || "Something went wrong.";
}
function debounce(fn, delay = 350) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}
function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value.seconds) return value.seconds * 1000;
  return 0;
}
function timeAgo(value) {
  const ms = timestampMs(value);
  if (!ms) return "just now";
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function trackFromDataset(button) {
  return JSON.parse(decodeURIComponent(button.dataset.track));
}
function encodeTrack(track) {
  return encodeURIComponent(JSON.stringify(track));
}

async function compressAvatar(file) {
  if (!file) return "";
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  const bitmap = await createImageBitmap(file);
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale, h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  let quality = .82;
  let data = canvas.toDataURL("image/jpeg", quality);
  while (data.length > 180000 && quality > .45) {
    quality -= .1;
    data = canvas.toDataURL("image/jpeg", quality);
  }
  if (data.length > 220000) throw new Error("That image could not be compressed enough. Try a smaller photo.");
  return data;
}

function switchAuth(mode) {
  const signup = mode === "signup";
  $("#show-signup").classList.toggle("active", signup);
  $("#show-signin").classList.toggle("active", !signup);
  $("#signup-form").classList.toggle("hidden", !signup);
  $("#signin-form").classList.toggle("hidden", signup);
}
$("#show-signup").addEventListener("click", () => switchAuth("signup"));
$("#show-signin").addEventListener("click", () => switchAuth("signin"));

let pendingAvatarData = "";
let signupInProgress = false;
$("#signup-avatar").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    pendingAvatarData = await compressAvatar(file);
    $("#signup-avatar-preview").src = pendingAvatarData;
    $("#signup-avatar-preview").classList.remove("hidden");
    $("#signup-avatar-placeholder").classList.add("hidden");
  } catch (err) { toast(err.message, "error"); }
});

$("#signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = e.submitter;
  submit.disabled = true;
  signupInProgress = true;
  let cred = null;
  try {
    const displayName = $("#signup-name").value.trim();
    const handle = $("#signup-handle").value.trim().replace(/^@/, "");
    const handleLower = handle.toLowerCase();
    cred = await createUserWithEmailAndPassword(auth, $("#signup-email").value.trim(), $("#signup-password").value);
    const avatarDataUrl = pendingAvatarData || placeholderAvatar(displayName);

    await runTransaction(db, async tx => {
      const handleRef = doc(db, "handles", handleLower);
      const handleSnap = await tx.get(handleRef);
      if (handleSnap.exists()) throw new Error("That @handle is already taken.");
      tx.set(handleRef, { uid: cred.user.uid, createdAt: serverTimestamp() });
      tx.set(doc(db, "users", cred.user.uid), {
        displayName,
        displayNameLower: displayName.toLowerCase(),
        handle,
        handleLower,
        avatarDataUrl,
        musicProvider: "spotify",
        createdAt: serverTimestamp(),
      });
    });

    await updateProfile(cred.user, { displayName, photoURL: avatarDataUrl.length < 2000 ? avatarDataUrl : null });
    e.target.reset(); pendingAvatarData = "";
    signupInProgress = false;
    await initApp(cred.user);
  } catch (err) {
    if (cred?.user && !state.profile) await deleteUser(cred.user).catch(() => {});
    toast(friendlyError(err), "error");
  } finally { signupInProgress = false; submit.disabled = false; }
});

$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = e.submitter; submit.disabled = true;
  try { await signInWithEmailAndPassword(auth, $("#signin-email").value.trim(), $("#signin-password").value); }
  catch (err) { toast(friendlyError(err), "error"); }
  finally { submit.disabled = false; }
});

$("#signout-btn").addEventListener("click", async () => { await signOut(auth); });

function cleanupListeners() {
  state.unsubscribers.forEach(fn => { try { fn(); } catch {} });
  state.unsubscribers = [];
  if (state.playlistSongsUnsub) state.playlistSongsUnsub();
  state.playlistSongsUnsub = null;
}

async function loadProfile(uid) {
  if (state.profiles.has(uid)) return state.profiles.get(uid);
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  const profile = { uid: snap.id, ...snap.data() };
  state.profiles.set(uid, profile);
  return profile;
}

async function hydrateProfiles(ids = []) {
  await Promise.all([...new Set(ids.filter(Boolean))].map(loadProfile));
}

async function initApp(user) {
  state.user = user;
  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists()) {
    toast("Your profile document is missing. Create a new account or add it in Firestore.", "error");
    await signOut(auth); return;
  }
  state.profile = { uid: user.uid, ...snap.data() };
  state.profiles.set(user.uid, state.profile);
  $("#sidebar-name").textContent = state.profile.displayName;
  $("#sidebar-handle").textContent = `@${state.profile.handle}`;
  $("#sidebar-avatar").src = state.profile.avatarDataUrl || placeholderAvatar(state.profile.displayName);
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  bindLiveData();
}

onAuthStateChanged(auth, async (user) => {
  if (signupInProgress) return;
  cleanupListeners();
  if (!user) {
    state.user = null; state.profile = null; state.friends = []; state.friendships = []; state.playlists = [];
    $("#app-view").classList.add("hidden");
    $("#auth-view").classList.remove("hidden");
    return;
  }
  try { await initApp(user); } catch (err) { toast(friendlyError(err), "error"); }
});

function bindLiveData() {
  const uid = state.user.uid;
  const friendshipsQ = query(collection(db, "friendships"), where("members", "array-contains", uid));
  state.unsubscribers.push(onSnapshot(friendshipsQ, async snap => {
    state.friendships = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const accepted = state.friendships.filter(f => f.status === "accepted");
    const friendIds = accepted.map(f => f.members.find(id => id !== uid)).filter(Boolean);
    await hydrateProfiles(friendIds.concat(state.friendships.flatMap(f => f.members)));
    state.friends = friendIds.map(id => state.profiles.get(id)).filter(Boolean);
    renderFriends(); renderFriendTargetMenu(); renderPlaylistFriendOptions();
  }, err => toast(friendlyError(err), "error")));

  const playlistsQ = query(collection(db, "playlists"), where("memberIds", "array-contains", uid));
  state.unsubscribers.push(onSnapshot(playlistsQ, async snap => {
    state.playlists = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt));
    await hydrateProfiles(state.playlists.flatMap(p => p.memberIds || []));
    renderPlaylists();
    if (state.currentPlaylist) {
      const latest = state.playlists.find(p => p.id === state.currentPlaylist.id);
      if (latest) { state.currentPlaylist = latest; renderPlaylistHeader(); }
    }
  }, err => toast(friendlyError(err), "error")));

  const suggestionsQ = query(collection(db, "suggestions"), where("toUid", "==", uid), orderBy("createdAt", "desc"), limit(16));
  state.unsubscribers.push(onSnapshot(suggestionsQ, async snap => {
    const suggestions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    await hydrateProfiles(suggestions.map(s => s.fromUid));
    renderSuggestions(suggestions);
  }, err => {
    // If a project still needs the included composite index, this surfaces a useful message.
    console.error(err);
    toast("Suggestions need the included Firestore index. Deploy firestore.indexes.json, then refresh.", "error");
  }));
}

const pageMeta = {
  home: ["For you", "Home"],
  playlists: ["Together", "Playlists"],
  friends: ["Your circle", "Friends"],
  "playlist-detail": ["Collaborative", "Playlist"],
};
function showPage(name) {
  $$(".page").forEach(p => p.classList.remove("active"));
  $(`#page-${name}`).classList.add("active");
  $$(".nav-item[data-page]").forEach(n => n.classList.toggle("active", n.dataset.page === name || (name === "playlist-detail" && n.dataset.page === "playlists")));
  const [eyebrow, title] = pageMeta[name] || ["", ""];
  $("#page-eyebrow").textContent = eyebrow; $("#page-title").textContent = title;
  $(".sidebar").classList.remove("open");
}
$$(".nav-item[data-page]").forEach(btn => btn.addEventListener("click", () => showPage(btn.dataset.page)));
$("#mobile-menu-btn").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#hero-search-focus").addEventListener("click", () => { $("#suggest-search").scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(() => $("#suggest-search").focus(), 350); });

function friendStatusWith(targetUid) {
  return state.friendships.find(f => f.members.includes(targetUid));
}
function pairId(a, b) { return [a,b].sort().join("_"); }

async function searchUsers(term) {
  const qText = term.trim().toLowerCase().replace(/^@/, "");
  const container = $("#friend-search-results");
  if (qText.length < 2) { container.innerHTML = ""; return; }
  container.innerHTML = `<div class="search-status">Searching…</div>`;
  try {
    const byHandle = getDocs(query(collection(db, "users"), where("handleLower", ">=", qText), where("handleLower", "<=", qText + "\uf8ff"), limit(8)));
    const byName = getDocs(query(collection(db, "users"), where("displayNameLower", ">=", qText), where("displayNameLower", "<=", qText + "\uf8ff"), limit(8)));
    const [a,b] = await Promise.all([byHandle, byName]);
    const map = new Map();
    [...a.docs, ...b.docs].forEach(d => map.set(d.id, { uid: d.id, ...d.data() }));
    map.delete(state.user.uid);
    const results = [...map.values()].slice(0, 10);
    results.forEach(p => state.profiles.set(p.uid, p));
    if (!results.length) { container.innerHTML = `<div class="search-status">No people found.</div>`; return; }
    container.innerHTML = results.map(person => friendRowHtml(person, true)).join("");
  } catch (err) { container.innerHTML = `<div class="search-status">${escapeHtml(friendlyError(err))}</div>`; }
}
$("#friend-search").addEventListener("input", debounce(e => searchUsers(e.target.value), 300));

function friendRowHtml(person, searchMode = false, request = null) {
  const relationship = friendStatusWith(person.uid);
  let action = "";
  if (request) {
    action = `<div class="actions"><button class="secondary-btn accept-request" data-id="${request.id}">Accept</button><button class="text-btn decline-request" data-id="${request.id}">Decline</button></div>`;
  } else if (searchMode) {
    if (relationship?.status === "accepted") action = `<button class="text-btn" disabled>Friends</button>`;
    else if (relationship?.status === "pending") action = `<button class="text-btn" disabled>${relationship.requestedBy === state.user.uid ? "Requested" : "Request received"}</button>`;
    else action = `<button class="secondary-btn add-friend" data-uid="${person.uid}">Add friend</button>`;
  } else {
    action = `<button class="text-btn danger remove-friend" data-uid="${person.uid}">Remove</button>`;
  }
  return `<div class="friend-row"><img src="${escapeHtml(person.avatarDataUrl || placeholderAvatar(person.displayName))}" alt=""><div class="meta"><b>${escapeHtml(person.displayName)}</b><small>@${escapeHtml(person.handle)}</small></div>${action}</div>`;
}

function renderFriends() {
  const uid = state.user.uid;
  const incoming = state.friendships.filter(f => f.status === "pending" && f.requestedBy !== uid);
  $("#friend-badge").textContent = incoming.length;
  $("#friend-badge").classList.toggle("hidden", incoming.length === 0);
  $("#incoming-section").classList.toggle("hidden", incoming.length === 0);
  $("#incoming-requests").innerHTML = incoming.map(req => {
    const otherId = req.members.find(id => id !== uid);
    const person = state.profiles.get(otherId);
    return person ? friendRowHtml(person, false, req) : "";
  }).join("");
  $("#friends-list").innerHTML = state.friends.map(p => friendRowHtml(p)).join("");
  $("#friends-empty").classList.toggle("hidden", state.friends.length > 0);
}

$("#page-friends").addEventListener("click", async (e) => {
  const addBtn = e.target.closest(".add-friend");
  const acceptBtn = e.target.closest(".accept-request");
  const declineBtn = e.target.closest(".decline-request");
  const removeBtn = e.target.closest(".remove-friend");
  try {
    if (addBtn) {
      const targetUid = addBtn.dataset.uid;
      await setDoc(doc(db, "friendships", pairId(state.user.uid, targetUid)), { members: [state.user.uid, targetUid].sort(), requestedBy: state.user.uid, status: "pending", createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      toast("Friend request sent.");
      searchUsers($("#friend-search").value);
    }
    if (acceptBtn) { await updateDoc(doc(db, "friendships", acceptBtn.dataset.id), { status: "accepted", updatedAt: serverTimestamp() }); toast("Friend added."); }
    if (declineBtn) { await deleteDoc(doc(db, "friendships", declineBtn.dataset.id)); }
    if (removeBtn) { await deleteDoc(doc(db, "friendships", pairId(state.user.uid, removeBtn.dataset.uid))); toast("Friend removed."); }
  } catch (err) { toast(friendlyError(err), "error"); }
});

function renderFriendTargetMenu() {
  const menu = $("#suggest-target-menu");
  if (!state.friends.length) {
    menu.innerHTML = `<div class="search-status">Add a friend first.</div>`;
    state.suggestionTargets.clear(); updateTargetLabel(); return;
  }
  for (const uid of [...state.suggestionTargets]) if (!state.friends.some(f => f.uid === uid)) state.suggestionTargets.delete(uid);
  menu.innerHTML = state.friends.map(f => `<label class="check-option"><img src="${escapeHtml(f.avatarDataUrl || placeholderAvatar(f.displayName))}" alt=""><span class="meta"><b>${escapeHtml(f.displayName)}</b><small>@${escapeHtml(f.handle)}</small></span><input type="checkbox" value="${f.uid}" ${state.suggestionTargets.has(f.uid) ? "checked" : ""}></label>`).join("");
  updateTargetLabel();
}
function updateTargetLabel() {
  const n = state.suggestionTargets.size;
  $("#suggest-target-label").textContent = n === 0 ? "Choose friends" : n === 1 ? "1 friend selected" : `${n} friends selected`;
}
$("#suggest-target-btn").addEventListener("click", () => $("#suggest-target-menu").classList.toggle("hidden"));
$("#suggest-target-menu").addEventListener("change", e => {
  if (e.target.type !== "checkbox") return;
  if (e.target.checked) state.suggestionTargets.add(e.target.value); else state.suggestionTargets.delete(e.target.value);
  updateTargetLabel();
});
document.addEventListener("click", e => {
  if (!e.target.closest("#suggest-target-btn") && !e.target.closest("#suggest-target-menu")) $("#suggest-target-menu").classList.add("hidden");
});

function trackRowHtml(track, action = "suggest", alreadyAdded = false) {
  const payload = encodeTrack(track);
  return `<div class="track-row">
    <img class="track-cover" src="${escapeHtml(track.artwork || placeholderAvatar("♫"))}" alt="">
    <div class="track-main"><b>${escapeHtml(track.title)}</b><small>${escapeHtml(track.artist)}${track.explicit ? " · E" : ""}</small></div>
    <div class="track-album">${escapeHtml(track.album || "")}</div>
    <div class="track-actions">
      ${track.previewUrl ? `<button class="round-btn preview-btn" data-track="${payload}" aria-label="Preview song" title="Preview">▶</button>` : ""}
      <button class="round-btn primary ${action === "suggest" ? "suggest-track" : "add-track"}" data-track="${payload}" ${alreadyAdded ? "disabled" : ""} aria-label="${action === "suggest" ? "Suggest" : "Add"}" title="${alreadyAdded ? "Already in playlist" : action === "suggest" ? "Suggest to selected friends" : "Add to playlist"}">${alreadyAdded ? "✓" : action === "suggest" ? "→" : "+"}</button>
    </div>
  </div>`;
}

async function runSongSearch(input, resultsEl, statusEl, action) {
  const term = input.value.trim();
  if (term.length < 2) { resultsEl.innerHTML = ""; statusEl.textContent = "Type at least 2 characters."; return; }
  statusEl.textContent = "Searching…";
  try {
    const tracks = await searchSongs(term, 20);
    if (input.value.trim() !== term) return;
    statusEl.textContent = tracks.length ? `${tracks.length} best matches` : "No songs found.";
    const existingKeys = action === "add" ? new Set(state.currentPlaylistSongs.map(s => s.trackKey)) : new Set();
    resultsEl.innerHTML = tracks.map(t => trackRowHtml(t, action === "add" ? "add" : "suggest", existingKeys.has(trackKey(t)))).join("");
  } catch (err) { statusEl.textContent = err.message || "Search failed."; resultsEl.innerHTML = ""; }
}
const suggestSearchDebounced = debounce(() => runSongSearch($("#suggest-search"), $("#suggest-search-results"), $("#suggest-search-status"), "suggest"), 360);
const playlistSearchDebounced = debounce(() => runSongSearch($("#playlist-search"), $("#playlist-search-results"), $("#playlist-search-status"), "add"), 360);
$("#suggest-search").addEventListener("input", suggestSearchDebounced);
$("#playlist-search").addEventListener("input", playlistSearchDebounced);

async function togglePreview(track, button) {
  const audio = $("#preview-audio");
  if (!track.previewUrl) return;
  $$(".preview-btn").forEach(b => b.textContent = "▶");
  if (state.previewingUrl === track.previewUrl && !audio.paused) {
    audio.pause(); state.previewingUrl = ""; button.textContent = "▶"; return;
  }
  audio.src = track.previewUrl; state.previewingUrl = track.previewUrl;
  await audio.play(); button.textContent = "❚❚";
}
$("#preview-audio").addEventListener("ended", () => { state.previewingUrl = ""; $$(".preview-btn").forEach(b => b.textContent = "▶"); });

document.addEventListener("click", async e => {
  const preview = e.target.closest(".preview-btn");
  if (preview) { try { await togglePreview(trackFromDataset(preview), preview); } catch { toast("Preview could not play.", "error"); } }
});

$("#suggest-search-results").addEventListener("click", async e => {
  const btn = e.target.closest(".suggest-track");
  if (!btn) return;
  if (!state.suggestionTargets.size) { toast("Choose at least one friend first.", "error"); $("#suggest-target-menu").classList.remove("hidden"); return; }
  const track = trackFromDataset(btn); btn.disabled = true;
  try {
    const batch = writeBatch(db);
    for (const toUid of state.suggestionTargets) {
      const ref = doc(collection(db, "suggestions"));
      batch.set(ref, { fromUid: state.user.uid, toUid, track: { ...track }, createdAt: serverTimestamp(), status: "unseen" });
    }
    await batch.commit();
    toast(`Suggested to ${state.suggestionTargets.size} friend${state.suggestionTargets.size > 1 ? "s" : ""}.`);
    state.suggestionTargets.clear(); renderFriendTargetMenu();
  } catch (err) { toast(friendlyError(err), "error"); btn.disabled = false; }
});

async function renderSuggestions(suggestions) {
  const el = $("#recent-suggestions");
  $("#suggestion-empty").classList.toggle("hidden", suggestions.length > 0);
  el.innerHTML = suggestions.map(s => {
    const sender = state.profiles.get(s.fromUid) || { displayName: "Friend", avatarDataUrl: placeholderAvatar("F") };
    const t = s.track || {};
    return `<article class="suggestion-card">
      <img class="cover" src="${escapeHtml(t.artwork || placeholderAvatar("♫"))}" alt="">
      <h4>${escapeHtml(t.title || "Unknown track")}</h4>
      <div class="artist">${escapeHtml(t.artist || "Unknown artist")}</div>
      <div class="suggested-by"><img src="${escapeHtml(sender.avatarDataUrl || placeholderAvatar(sender.displayName))}" alt=""><span>${escapeHtml(sender.displayName)} · ${timeAgo(s.createdAt)}</span></div>
      <div class="card-actions">
        ${t.previewUrl ? `<button class="secondary-btn suggestion-preview" data-track="${encodeTrack(t)}">Preview</button>` : ""}
        <button class="secondary-btn open-provider" data-track="${encodeTrack(t)}">＋ Music app</button>
      </div>
    </article>`;
  }).join("");
}
$("#recent-suggestions").addEventListener("click", async e => {
  const preview = e.target.closest(".suggestion-preview");
  const open = e.target.closest(".open-provider");
  if (preview) { try { await togglePreview(trackFromDataset(preview), preview); } catch {} }
  if (open) window.open(providerUrl(trackFromDataset(open), state.profile.musicProvider), "_blank", "noopener,noreferrer");
});

function renderPlaylistFriendOptions() {
  const box = $("#playlist-friend-options");
  box.innerHTML = state.friends.length ? state.friends.map(f => `<label class="check-option"><img src="${escapeHtml(f.avatarDataUrl || placeholderAvatar(f.displayName))}" alt=""><span class="meta"><b>${escapeHtml(f.displayName)}</b><small>@${escapeHtml(f.handle)}</small></span><input type="checkbox" value="${f.uid}"></label>`).join("") : `<div class="search-status">You can create a solo playlist now, or add friends first.</div>`;
}
function openPlaylistDialog() { renderPlaylistFriendOptions(); $("#playlist-dialog").showModal(); }
$("#new-playlist-btn").addEventListener("click", openPlaylistDialog);
$("#empty-new-playlist").addEventListener("click", openPlaylistDialog);
$("#playlist-form").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#playlist-name").value.trim();
  if (!name) return;
  const selected = $$("#playlist-friend-options input:checked").map(i => i.value);
  const submit = $("#create-playlist-submit"); submit.disabled = true;
  try {
    await addDoc(collection(db, "playlists"), { name, ownerId: state.user.uid, memberIds: [state.user.uid, ...selected], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    $("#playlist-dialog").close(); e.target.reset(); toast("Playlist created.");
  } catch (err) { toast(friendlyError(err), "error"); }
  finally { submit.disabled = false; }
});

function renderPlaylists() {
  const grid = $("#playlist-grid");
  $("#playlist-empty").classList.toggle("hidden", state.playlists.length > 0);
  grid.innerHTML = state.playlists.map(p => {
    const members = (p.memberIds || []).map(id => state.profiles.get(id)).filter(Boolean).slice(0,5);
    return `<article class="playlist-card" data-id="${p.id}"><div class="playlist-card-art">♫</div><h4>${escapeHtml(p.name)}</h4><p>${(p.memberIds || []).length} member${(p.memberIds || []).length === 1 ? "" : "s"}</p><div class="avatar-stack">${members.map(m => `<img src="${escapeHtml(m.avatarDataUrl || placeholderAvatar(m.displayName))}" title="${escapeHtml(m.displayName)}" alt="">`).join("")}</div></article>`;
  }).join("");
}
$("#playlist-grid").addEventListener("click", e => {
  const card = e.target.closest(".playlist-card"); if (!card) return;
  openPlaylist(card.dataset.id);
});
$("#back-playlists").addEventListener("click", () => showPage("playlists"));

async function openPlaylist(id) {
  const playlist = state.playlists.find(p => p.id === id);
  if (!playlist) return;
  state.currentPlaylist = playlist;
  await hydrateProfiles(playlist.memberIds || []);
  renderPlaylistHeader(); showPage("playlist-detail");
  $("#playlist-search").value = ""; $("#playlist-search-results").innerHTML = ""; $("#playlist-search-status").textContent = "Search for a song to add.";
  if (state.playlistSongsUnsub) state.playlistSongsUnsub();
  const songsQ = query(collection(db, "playlists", id, "songs"), orderBy("addedAt", "desc"));
  state.playlistSongsUnsub = onSnapshot(songsQ, async snap => {
    state.currentPlaylistSongs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    await hydrateProfiles(state.currentPlaylistSongs.map(s => s.addedBy));
    renderPlaylistSongs();
  }, err => toast(friendlyError(err), "error"));
}
function renderPlaylistHeader() {
  const p = state.currentPlaylist; if (!p) return;
  $("#playlist-detail-name").textContent = p.name;
  const members = (p.memberIds || []).map(id => state.profiles.get(id)).filter(Boolean);
  $("#playlist-detail-meta").textContent = `${state.currentPlaylistSongs.length} song${state.currentPlaylistSongs.length === 1 ? "" : "s"} · ${members.length} member${members.length === 1 ? "" : "s"}`;
  $("#playlist-members").innerHTML = members.map(m => `<img src="${escapeHtml(m.avatarDataUrl || placeholderAvatar(m.displayName))}" title="${escapeHtml(m.displayName)}" alt="">`).join("");
}
function renderPlaylistSongs() {
  const songs = state.currentPlaylistSongs;
  $("#playlist-track-empty").classList.toggle("hidden", songs.length > 0);
  $("#playlist-tracks").innerHTML = songs.map(song => {
    const t = song.track || {};
    const adder = state.profiles.get(song.addedBy) || { displayName: "Friend", avatarDataUrl: placeholderAvatar("F") };
    return `<div class="playlist-song">
      <img class="track-cover" src="${escapeHtml(t.artwork || placeholderAvatar("♫"))}" alt="">
      <div class="track-main"><b>${escapeHtml(t.title || "Unknown track")}</b><small>${escapeHtml(t.artist || "Unknown artist")}</small></div>
      <div class="track-album">${escapeHtml(t.album || "")}</div>
      <div class="added-by"><img src="${escapeHtml(adder.avatarDataUrl || placeholderAvatar(adder.displayName))}" alt=""><span>Added by ${escapeHtml(adder.displayName)}</span></div>
      <div class="track-actions">${t.previewUrl ? `<button class="round-btn preview-btn" data-track="${encodeTrack(t)}" title="Preview">▶</button>` : ""}<button class="round-btn music-plus open-provider" data-track="${encodeTrack(t)}" title="Open in ${escapeHtml(state.profile.musicProvider || "music app")}">＋</button></div>
    </div>`;
  }).join("");
  renderPlaylistHeader();
  if ($("#playlist-search").value.trim().length >= 2) playlistSearchDebounced();
}
$("#playlist-search-results").addEventListener("click", async e => {
  const btn = e.target.closest(".add-track"); if (!btn || !state.currentPlaylist) return;
  const track = trackFromDataset(btn); btn.disabled = true;
  try {
    const key = trackKey(track);
    await setDoc(doc(db, "playlists", state.currentPlaylist.id, "songs", key), { trackKey: key, track, addedBy: state.user.uid, addedAt: serverTimestamp() });
    await updateDoc(doc(db, "playlists", state.currentPlaylist.id), { updatedAt: serverTimestamp() });
    toast("Added to playlist.");
  } catch (err) { toast(friendlyError(err), "error"); btn.disabled = false; }
});
$("#playlist-tracks").addEventListener("click", e => {
  const open = e.target.closest(".open-provider");
  if (open) window.open(providerUrl(trackFromDataset(open), state.profile.musicProvider), "_blank", "noopener,noreferrer");
});

$("#settings-btn").addEventListener("click", () => {
  const value = state.profile?.musicProvider || "spotify";
  const radio = $(`#settings-form input[value="${value}"]`); if (radio) radio.checked = true;
  $("#settings-dialog").showModal();
});
$("#settings-form").addEventListener("submit", async e => {
  e.preventDefault();
  const provider = new FormData(e.target).get("provider") || "spotify";
  try {
    await updateDoc(doc(db, "users", state.user.uid), { musicProvider: provider });
    state.profile.musicProvider = provider; state.profiles.set(state.user.uid, state.profile);
    $("#settings-dialog").close(); toast("Music app updated.");
  } catch (err) { toast(friendlyError(err), "error"); }
});

// Keep modal cancel buttons from accidentally submitting in older browsers.
$$("dialog button[value='cancel']").forEach(btn => btn.addEventListener("click", () => btn.closest("dialog")?.close()));
