const callbacks = new Map();
let searchSerial = 0;

function normalize(value = "") {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function scoreTrack(track, queryText) {
  const q = normalize(queryText);
  const tokens = q.split(" ").filter(Boolean);
  const title = normalize(track.title);
  const artist = normalize(track.artist);
  const album = normalize(track.album);
  let score = 0;
  if (title === q) score += 100;
  if (`${title} ${artist}` === q) score += 120;
  if (artist === q) score += 55;
  if (title.startsWith(q)) score += 45;
  if (artist.startsWith(q)) score += 25;
  for (const token of tokens) {
    if (title.includes(token)) score += 14;
    if (artist.includes(token)) score += 10;
    if (album.includes(token)) score += 5;
  }
  return score;
}

function mapResult(item) {
  const artwork = (item.artworkUrl100 || "").replace("100x100bb", "300x300bb");
  return {
    id: String(item.trackId || `${item.artistId}-${item.trackName}`),
    title: item.trackName || "Unknown track",
    artist: item.artistName || "Unknown artist",
    album: item.collectionName || "Single",
    artwork,
    previewUrl: item.previewUrl || "",
    appleUrl: item.trackViewUrl || item.collectionViewUrl || "",
    durationMs: item.trackTimeMillis || 0,
    explicit: item.trackExplicitness === "explicit",
  };
}

function countryFromLocale() {
  const locale = navigator.language || "en-US";
  const part = locale.split("-")[1];
  return /^[A-Z]{2}$/i.test(part || "") ? part.toUpperCase() : "US";
}

export function searchSongs(term, maxResults = 20) {
  const q = term.trim();
  if (!q) return Promise.resolve([]);
  const serial = ++searchSerial;
  return new Promise((resolve, reject) => {
    const callbackName = `__resonanceSearch${Date.now()}${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timeout = setTimeout(() => cleanup(new Error("Search timed out")), 9000);

    function cleanup(error, results) {
      clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
      callbacks.delete(callbackName);
      if (error) reject(error); else resolve(results);
    }

    callbacks.set(callbackName, script);
    window[callbackName] = (payload) => {
      if (serial !== searchSerial) return cleanup(null, []);
      const tracks = (payload.results || []).map(mapResult);
      tracks.sort((a, b) => scoreTrack(b, q) - scoreTrack(a, q));
      cleanup(null, tracks.slice(0, maxResults));
    };
    script.onerror = () => cleanup(new Error("Could not reach the music catalog"));
    const params = new URLSearchParams({
      term: q,
      entity: "song",
      media: "music",
      limit: String(Math.min(50, Math.max(maxResults + 10, 25))),
      country: countryFromLocale(),
      callback: callbackName,
    });
    script.src = `https://itunes.apple.com/search?${params.toString()}`;
    document.head.appendChild(script);
  });
}

export function providerUrl(track, provider = "spotify") {
  const q = encodeURIComponent(`${track.title} ${track.artist}`);
  if (provider === "apple") return track.appleUrl || `https://music.apple.com/us/search?term=${q}`;
  if (provider === "youtube") return `https://music.youtube.com/search?q=${q}`;
  return `https://open.spotify.com/search/${q}`;
}

export function trackKey(track) {
  return `itunes_${String(track.id).replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
