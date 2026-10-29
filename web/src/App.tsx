import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Category } from "@taste-bridge/shared";

type Favorite = { qlooId: string; name: string; entityType: string; source?: "manual" | "chat" | "demo" };
type Member = { id: string; nickname: string; isHost: boolean; ready: boolean; hasChatted: boolean; favorites: Favorite[] };
type ChatMessage = { id: string; memberId: string; nickname: string; text: string; createdAt: number };
type PlanActivityItem = { id: number; eventType: string; summary: string; createdAt: number };
type Pick = {
  pickId: string;
  category: Category;
  qloo: { entityId: string; name: string; overlapScore: number; memberAffinity: Record<string, number> };
  agent: { fallback: boolean; blurb: string; reasons: Record<string, string> };
  votes: { up: number; down: number; mine: "up" | "down" | null };
};
type Room = {
  id: string;
  categories: Category[];
  city: string | null;
  status: "gathering" | "generating" | "ready" | "failed";
  planStatus: string;
  planError: string | null;
  memberCount: number;
  readyCount: number;
  members: Member[];
  planVersion: number;
  planCooldownSeconds: number;
  picks: Pick[];
  planActivity: PlanActivityItem[];
  chatMessages: ChatMessage[];
  me: { memberId: string; isHost: boolean; ready: boolean } | null;
};
type SearchResult = { id: string; name: string; entityType: string; subtitle: string };
type FavoriteType = Category | "tag";
const categoryInfo: Record<Category, { label: string; icon: string; entityType: string }> = {
  dining: { label: "Dinner", icon: "🍜", entityType: "place" },
  music: { label: "Music", icon: "🎧", entityType: "artist" },
  film_tv: { label: "Movie night", icon: "🎬", entityType: "movie" },
  tv_show: { label: "TV shows", icon: "📺", entityType: "tv_show" },
  books: { label: "Books", icon: "📚", entityType: "book" },
  podcasts: { label: "Podcasts", icon: "🎙️", entityType: "podcast" },
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { "Content-Type": "application/json", ...init?.headers } });
  const payload = await response.json();
  if (!response.ok) {
    throw new ApiRequestError(
      payload.error?.message ?? "Something went wrong.",
      payload.error?.code,
      Number(response.headers.get("Retry-After")) || 0,
    );
  }
  return payload as T;
}
class ApiRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly retryAfterSeconds = 0) {
    super(message);
  }
}
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export default function App() {
  const [room, setRoom] = useState<Room | null>(null);
  const [roomId, setRoomId] = useState(() => location.pathname.match(/^\/r\/([A-Za-z0-9_-]{8,32})$/)?.[1] ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [planCooldownSeconds, setPlanCooldownSeconds] = useState(0);
  const [nickname, setNickname] = useState("");
  const [city, setCity] = useState("");
  const [categories, setCategories] = useState<Category[]>(["dining", "music", "film_tv"]);
  const [searchCategory, setSearchCategory] = useState<FavoriteType>("music");
  const [searchText, setSearchText] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [chatSuggestions, setChatSuggestions] = useState<SearchResult[]>([]);
  const [chatSuggestionSource, setChatSuggestionSource] = useState<"gemini" | "messages" | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [activeRoomTab, setActiveRoomTab] = useState<"chat" | "plan">("chat");
  const [linkCopied, setLinkCopied] = useState(false);
  const [chatText, setChatText] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const savedFavoritesSnapshot = useRef<{ memberId: string; favorites: string } | null>(null);

  const loadRoom = useCallback(async (id: string) => {
    const response = await request<{ room: Room }>(`/api/rooms/${id}`);
    setRoom(response.room);
  }, []);
  useEffect(() => {
    if (!roomId) return;
    loadRoom(roomId).catch((err: Error) => setError(err.message));
  }, [roomId, loadRoom]);
  useEffect(() => {
    if (!roomId || !room?.me?.memberId) return;
    const stream = new EventSource(`/api/rooms/${roomId}/events`);
    const refresh = () => loadRoom(roomId).catch((err: Error) => setError(err.message));
    stream.addEventListener("room_updated", refresh);
    return () => stream.close();
  }, [roomId, room?.me?.memberId, loadRoom]);
  useEffect(() => {
    const syncPath = () => {
      const id = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{8,32})$/)?.[1] ?? null;
      setRoomId(id);
      if (!id) setRoom(null);
    };
    addEventListener("popstate", syncPath);
    return () => removeEventListener("popstate", syncPath);
  }, []);
  useEffect(() => {
    if (!room?.me) {
      savedFavoritesSnapshot.current = null;
      return;
    }
    const member = room.members.find((item) => item.id === room.me?.memberId);
    if (!member) return;
    const favoritesSnapshot = JSON.stringify(member.favorites);
    const previousSnapshot = savedFavoritesSnapshot.current;
    if (!previousSnapshot || previousSnapshot.memberId !== member.id ||
      previousSnapshot.favorites !== favoritesSnapshot) {
      setFavorites(member.favorites);
      savedFavoritesSnapshot.current = { memberId: member.id, favorites: favoritesSnapshot };
    }
  }, [room]);
  useEffect(() => {
    const container = chatMessagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [room?.chatMessages]);
  useEffect(() => {
    setPlanCooldownSeconds(room?.planCooldownSeconds ?? 0);
  }, [room?.planCooldownSeconds]);
  useEffect(() => {
    if (planCooldownSeconds <= 0) return;
    const timer = window.setTimeout(() => setPlanCooldownSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [planCooldownSeconds]);

  const changeCategories = (category: Category) => setCategories((current) =>
    current.includes(category) ? current.filter((item) => item !== category) : [...current, category]);
  const createRoom = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await request<{ room: Room }>("/api/rooms", json("POST", { nickname, categories, city: categories.includes("dining") ? city : null }));
      setActiveRoomTab("chat");
      setRoom(response.room); setRoomId(response.room.id); history.pushState({}, "", `/r/${response.room.id}`);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const createDemoRoom = async () => {
    if (!nickname.trim()) {
      setError("Enter a nickname to start the demo.");
      return;
    }
    if (categories.includes("dining") && !city.trim()) {
      setError("Enter a city or area to include Dinner in the demo.");
      return;
    }
    setBusy(true); setDemoBusy(true); setError("");
    try {
      const response = await request<{ room: Room }>("/api/rooms", json("POST", { nickname, categories, city: categories.includes("dining") ? city : null }));
      const createdRoomId = response.room.id;
      setRoom(response.room); setRoomId(createdRoomId); history.pushState({}, "", `/r/${createdRoomId}`);
      await request(`/api/rooms/${createdRoomId}/demo`, json("POST", {}));
      setActiveRoomTab("plan");
      await loadRoom(createdRoomId);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); setDemoBusy(false); }
  };
  const useBrowserLocation = () => {
    setError("");
    if (!navigator.geolocation) {
      setError("Browser location is unavailable. Enter a city or area instead.");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition((position) => {
      request<{ city: string }>("/api/location/resolve", json("POST", {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      })).then((result) => setCity(result.city))
        .catch((err: Error) => setError(err.message))
        .finally(() => setBusy(false));
    }, () => {
      setError("Location permission was not granted. Enter a city or area instead.");
      setBusy(false);
    }, { timeout: 10_000, maximumAge: 0 });
  };
  const joinRoom = async (event: React.FormEvent) => {
    event.preventDefault(); if (!roomId) return; setBusy(true); setError("");
    try {
      await request(`/api/rooms/${roomId}/join`, json("POST", { nickname }));
      setActiveRoomTab("chat");
      await loadRoom(roomId);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const search = async (event: React.FormEvent) => {
    event.preventDefault(); if (!roomId) return; setBusy(true); setError("");
    try {
      const response = await request<{ results: SearchResult[] }>(`/api/rooms/${roomId}/search?q=${encodeURIComponent(searchText)}&type=${searchCategory}`);
      setResults(response.results);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const suggestFromChat = async () => {
    if (!roomId) return;
    setBusy(true); setError(""); setChatSuggestions([]); setChatSuggestionSource(null);
    try {
      const response = await request<{ results: SearchResult[]; keywordSource: "gemini" | "messages" }>(
        `/api/rooms/${roomId}/chat-suggestions`, json("POST", {}),
      );
      setChatSuggestions(response.results);
      setChatSuggestionSource(response.keywordSource);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const toggleFavorite = (result: SearchResult, source: Favorite["source"] = "manual") => setFavorites((current) => {
    if (current.some((item) => item.qlooId === result.id)) return current.filter((item) => item.qlooId !== result.id);
    if (current.length >= 4) return current;
    return [...current, { qlooId: result.id, name: result.name, entityType: result.entityType, source }];
  });
  const saveFavorites = async () => {
    if (!roomId) return; setBusy(true); setError("");
    try {
      await request(`/api/rooms/${roomId}/favorites`, json("PUT", { qlooIds: favorites.map((item) => item.qlooId) }));
      await loadRoom(roomId);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const makePlan = async () => {
    if (!roomId) return; setBusy(true); setError(""); setActiveRoomTab("plan");
    try { await request(`/api/rooms/${roomId}/plan`, json("POST", {})); await loadRoom(roomId); }
    catch (err) {
      if (err instanceof ApiRequestError && err.code === "PLAN_COOLDOWN") {
        setPlanCooldownSeconds(err.retryAfterSeconds || 30);
      } else setError((err as Error).message);
    } finally { setBusy(false); }
  };
  const runSoloDemo = async () => {
    if (!roomId) return;
    setDemoBusy(true); setError("");
    try {
      await request(`/api/rooms/${roomId}/demo`, json("POST", {}));
      setActiveRoomTab("plan");
      await loadRoom(roomId);
    } catch (err) { setError((err as Error).message); } finally { setDemoBusy(false); }
  };
  const sendChatMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!roomId || !chatText.trim()) return;
    setSendingChat(true); setError("");
    try {
      const response = await request<{ room: Room }>(`/api/rooms/${roomId}/chat`, json("POST", { text: chatText }));
      setRoom(response.room);
      setChatText("");
    } catch (err) { setError((err as Error).message); } finally { setSendingChat(false); }
  };
  const vote = async (pickId: string, direction: "up" | "down") => {
    if (!roomId) return; setError("");
    try {
      const pick = room?.picks.find((item) => item.pickId === pickId);
      await request(`/api/rooms/${roomId}/picks/${pickId}/vote`, json("PUT", { direction: pick?.votes.mine === direction ? null : direction }));
      await loadRoom(roomId);
    } catch (err) { setError((err as Error).message); }
  };
  const share = useCallback(async () => {
    if (!roomId) return;
    try { await navigator.clipboard.writeText(`${location.origin}/r/${roomId}`); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1800); }
    catch { setError("Copy the room link from your browser address bar."); }
  }, [roomId]);

  const me = room?.members.find((member) => member.id === room.me?.memberId);
  const readyCount = room?.members.filter((member) => member.ready).length ?? 0;
  const missingReadyMembers = room?.members.filter((member) => !member.ready) ?? [];
  const planAvailable = Boolean(room?.planVersion && room.picks.length > 0);
  const hasDemoFriends = Boolean(room?.members.some((member) => member.nickname === "Demo Maya" || member.nickname === "Demo Jordan"));
  const canRunSoloDemo = Boolean(room?.me?.isHost && (room.status === "gathering" || room.status === "failed") &&
    (room.memberCount === 1 || hasDemoFriends));
  const sortedPicks = useMemo(() => room?.picks ?? [], [room]);
  useEffect(() => {
    if (room && searchCategory !== "tag" && !room.categories.includes(searchCategory)) {
      setSearchCategory(room.categories[0] ?? "music");
    }
  }, [room, searchCategory]);

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="/" onClick={(event) => { event.preventDefault(); history.pushState({}, "", "/"); setRoomId(null); setRoom(null); setActiveRoomTab("chat"); setError(""); }}>
        <span className="brand-mark">tb</span><span>Taste Bridge</span>
      </a>
      <span className="top-note">Good plans start with what you love.</span>
      {roomId && <button className="quiet-button" onClick={share}>{linkCopied ? "Link copied ✓" : "Share room ↗"}</button>}
    </header>

    {error && <div className="alert" role="alert">{error}<button aria-label="Dismiss" onClick={() => setError("")}>×</button></div>}
    {!roomId ? <section className="hero-layout">
      <div className="hero-copy">
        <p className="eyebrow">LESS CHAT. MORE “LET'S GO.”</p>
        <h1>Find the thing<br />you'll <em>all</em> love.</h1>
        <p className="hero-intro">Bring your favorites. We’ll find the overlap and turn it into a plan everyone can get behind.</p>
        <div className="hero-stickers"><span>🍽️ somewhere good</span><span>🎶 something new</span><span>🎥 one everyone picks</span></div>
      </div>
      <form className="panel create-panel" onSubmit={createRoom}>
        <div className="panel-heading"><span className="step">01</span><div><h2>Start your room</h2><p>Pick a vibe. Invite your people.</p></div></div>
        <label>Your nickname<input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={24} required placeholder="What should friends call you?" /></label>
        <fieldset><legend>What are you planning?</legend><div className="category-grid">
          {(Object.keys(categoryInfo) as Category[]).map((item) => <button type="button" key={item} className={`category-choice ${categories.includes(item) ? "selected" : ""}`} onClick={() => changeCategories(item)}><span>{categoryInfo[item].icon}</span>{categoryInfo[item].label}{categories.includes(item) && <b>✓</b>}</button>)}
        </div></fieldset>
        {categories.includes("dining") && <><label>City or area<input value={city} onChange={(e) => setCity(e.target.value)} maxLength={100} required placeholder="e.g. Seattle, Fremont" /><small>City-level only. We never store precise location.</small></label><button className="location-button" type="button" onClick={useBrowserLocation} disabled={busy}>◎ Use browser location</button><p className="location-note">Optional: coordinates go once to OpenStreetMap to find your city. We don’t store them or send them to Qloo.</p></>}
        <button className="primary-button full" disabled={busy || !categories.length}>{busy ? "Creating room…" : "Create a room"} <span>→</span></button>
        <button className="demo-button full landing-demo-button" type="button" disabled={busy || demoBusy || !categories.length} onClick={createDemoRoom}>{demoBusy ? "Starting your demo…" : "Try a demo"}</button>
        <small className="demo-note landing-demo-note">Creates a room, adds two sample friends with live Qloo favorites, and opens the plan. Enter a nickname and a city if Dinner is selected.</small>
        <p className="fine-print">No account needed · Rooms expire after 3 days</p>
      </form>
    </section> : !room ? <div className="loading-card"><span className="loader" />Opening your room…</div> : !room.me ? <section className="join-layout">
      <div><p className="eyebrow">ROOM INVITE</p><h1>Come on in.</h1><p className="hero-intro">Join this private room to see the group and help find a plan.</p><RoomSummary room={room} /></div>
      {room.status === "gathering"
        ? <form className="panel join-panel" onSubmit={joinRoom}><span className="step">02</span><h2>Join the room</h2><label>Your nickname<input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={24} required autoFocus placeholder="A name your friends know" /></label><button className="primary-button full" disabled={busy}>{busy ? "Joining…" : "Join the chat →"}</button></form>
        : <div className="panel join-panel"><h2>This room is closed</h2><p>Only people who already joined can view its plan.</p></div>}
    </section> : <section className="room-layout">
      <div className="room-heading">
        <div><p className="eyebrow">{planAvailable ? "THE GROUP PLAN" : "ROOM · " + room.id.slice(0, 6).toUpperCase()}</p><h1>{planAvailable ? "Here’s your bridge." : "Let’s find your overlap."}</h1><p className="hero-intro">{room.city ? `Planning around ${room.city}. ` : ""}Share the link and bring everyone in.</p></div>
        <button className="quiet-button" onClick={share}>{linkCopied ? "Copied ✓" : "Copy invite link ↗"}</button>
      </div>
      <div className="room-columns">
        <aside className="side-column">
          <RoomSummary room={room} />
          {room.me && room.status === "gathering" && <section className="panel favorites-panel">
            <div className="panel-heading"><span className="step">03</span><div><h2>Your favorites</h2><p>Add 2–4 things you like (optional).</p></div></div>
            {me?.ready && <div className="ready-banner">Your favorites are in ✓ <button className="text-button" onClick={() => setFavorites(me.favorites)}>Edit</button></div>}
            <div className="favorite-chips">{favorites.map((item) => <button key={item.qlooId} onClick={() => setFavorites((current) => current.filter((f) => f.qlooId !== item.qlooId))}>{item.name}{item.source === "chat" && <small>CHAT</small>}<span>×</span></button>)}</div>
            <button type="button" className="suggest-chat-button" disabled={busy || room.chatMessages.filter((message) => message.memberId === room.me?.memberId).length < 3} onClick={suggestFromChat}>
              {busy ? "Finding Qloo suggestions…" : "Suggest from chat"}
            </button>
            <small className="suggest-chat-note">Uses your last three to five messages. Nothing is selected automatically.</small>
            {chatSuggestionSource && <div className="chat-suggestions">
              <strong>Suggested from chat</strong>
              {chatSuggestions.length > 0 ? <div className="suggestion-chips">{chatSuggestions.map((item) => {
                const selected = favorites.some((favorite) => favorite.qlooId === item.id);
                return <button type="button" key={item.id} className={selected ? "suggestion-chip selected" : "suggestion-chip"}
                  aria-pressed={selected} disabled={!selected && favorites.length >= 4}
                  onClick={() => toggleFavorite(item, "chat")}>{item.name}{selected ? " ✓" : " +" }
                </button>;
              })}</div> : <small>No matching entities found. Try the manual Qloo search below.</small>}
              <small>{chatSuggestionSource === "gemini" ? "Keywords extracted from your chat." : "Searched your recent messages directly."}{chatSuggestions.length > 0 && " Tap chips to select, then confirm below."}</small>
            </div>}
            <form className="search-form" onSubmit={search}>
              <select aria-label="Favorite type" value={searchCategory} onChange={(e) => setSearchCategory(e.target.value as FavoriteType)}><option value="tag">Cuisine / style</option>{room.categories.map((item) => <option value={item} key={item}>{categoryInfo[item].label}</option>)}</select>
              <input value={searchText} onChange={(e) => setSearchText(e.target.value)} minLength={2} placeholder="Search a favorite…" required />
              <button aria-label="Search">⌕</button>
            </form>
            {results.length > 0 && <div className="search-results">{results.map((item) => {
              const selected = favorites.some((fav) => fav.qlooId === item.id);
              return <button key={item.id} className={`result-row ${selected ? "result-selected" : ""}`} onClick={() => toggleFavorite(item)}><span className="result-plus">{selected ? "✓" : "+"}</span><span><strong>{item.name}</strong><small>{item.subtitle || item.entityType}</small></span></button>;
            })}</div>}
            <button className="primary-button full" disabled={busy || favorites.length < 2 || favorites.length > 4} onClick={saveFavorites}>{me?.ready ? "Update favorites" : "Confirm favorites"} <span>→</span></button>
            <p className="fine-print">Your nickname and personal details are never sent to Qloo.</p>
          </section>}
          {room.me?.isHost && <section className="make-plan-card"><div><strong>{readyCount} of {room.members.length} ready</strong><span>{room.members.length < 3 ? "Invite at least 2 friends" : readyCount < room.members.length ? "Waiting on everyone’s favorites" : "Everyone’s in — make it a plan."}</span></div>
            <button className="primary-button full" disabled={busy || planCooldownSeconds > 0 || room.status === "generating" || room.members.length < 3 || readyCount !== room.members.length} onClick={makePlan}>{room.status === "generating" ? "Finding your overlap…" : planCooldownSeconds > 0 ? `Available in ${planCooldownSeconds}s` : planAvailable ? "Find new picks ↻" : "Make our plan ✨"}</button>
            {planCooldownSeconds > 0 && <p className="host-waiting-note">Plans can be refreshed every 30 seconds, try again shortly.</p>}
            {canRunSoloDemo && <button className="demo-button full" disabled={busy || demoBusy || room.status === "generating"} onClick={runSoloDemo}>{demoBusy ? "Finding real Qloo favorites…" : "Fill with demo friends"}</button>}
            {canRunSoloDemo && <small className="demo-note">Adds two sample friends using live Qloo search, then generates a plan. No sample favorites are fabricated.</small>}
            {room.planStatus === "failed" && <p className="inline-error">The latest plan attempt failed. You can try again.</p>}
          </section>}
        </aside>
        <div className="main-column">
          <div className="room-tabs" role="tablist" aria-label="Room views">
            <button type="button" role="tab" aria-selected={activeRoomTab === "chat"} className={activeRoomTab === "chat" ? "active" : ""} onClick={() => setActiveRoomTab("chat")}>Chat</button>
            <button type="button" role="tab" aria-selected={activeRoomTab === "plan"} className={activeRoomTab === "plan" ? "active" : ""} onClick={() => setActiveRoomTab("plan")}>Plan {planAvailable ? "✓" : ""}</button>
          </div>
          {activeRoomTab === "plan" && (planAvailable ? <><PlanView room={room} picks={sortedPicks} onVote={vote} />{room.status === "generating" && <p className="score-disclaimer">Finding fresh picks. Your current plan stays visible until the new one is ready.</p>}</> : <section className="panel waiting-panel"><div className="waiting-illustration">🪄</div><p className="eyebrow">{room.status === "generating" ? "WORKING ON IT" : "THE MAGIC HAPPENS TOGETHER"}</p><h2>{room.status === "generating" ? "Finding your overlap…" : room.status === "failed" ? "We couldn’t make that plan yet." : missingReadyMembers.length ? "Waiting for favorites." : room.members.length < 3 ? "Invite at least two friends." : "Everyone’s ready."}</h2>
            {room.status === "generating"
              ? <p>Chat-derived favorites are weighted more strongly in the ranking, alongside everyone’s other confirmed favorites.</p>
              : room.status === "failed"
                ? <p>The last attempt did not finish. The host can try again when everyone is ready.</p>
                : missingReadyMembers.length
                  ? <p>Still waiting for {missingReadyMembers.map((member) => member.nickname).join(", ")} to confirm favorites. Chat-suggested favorites are optional and only count after confirmation.</p>
                  : room.members.length < 3
                    ? <p>Invite at least two friends and confirm favorites to make a group plan.</p>
                    : <p>Confirmed chat-suggested favorites will be the primary taste signal, combined with other confirmed favorites.</p>}
            {room.me?.isHost && !missingReadyMembers.length && room.members.length >= 3 && room.status !== "generating"
              ? <button className="primary-button plan-tab-action" disabled={busy || planCooldownSeconds > 0} onClick={makePlan}>{busy ? "Finding your overlap…" : planCooldownSeconds > 0 ? `Available in ${planCooldownSeconds}s` : "Make our plan ✨"}</button>
              : !room.me?.isHost && !missingReadyMembers.length && room.members.length >= 3 && room.status !== "generating"
                ? <p className="host-waiting-note">Everyone is Ready. Waiting for the host to make the plan.</p>
                : null}
          </section>)}
          {activeRoomTab === "plan" && room.planActivity.length > 0 && <PlanActivity items={room.planActivity} />}
          {activeRoomTab === "chat" && room.me && <section className="panel chat-panel">
            <div className="chat-heading"><div><p className="eyebrow">ROOM CHAT</p><h2>Talk it out</h2></div><span>Messages stay with this room</span></div>
            {hasDemoFriends && <p className="demo-chat-note"><strong>Scripted sample conversation:</strong> These messages don’t drive recommendations; demo friends’ favorites come from live Qloo searches. Send your own message and use Suggest from chat to add your own.</p>}
            <div className="chat-messages" ref={chatMessagesRef} role="log" aria-label="Group chat messages" aria-live="polite">
              {room.chatMessages.length ? room.chatMessages.map((message) => <article className={`chat-message ${message.memberId === room.me?.memberId ? "chat-message-mine" : ""}`} key={message.id}>
                <div><strong>{message.nickname}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>
                <p>{message.text}</p>
              </article>) : <p className="chat-empty">No messages yet. Start the conversation with your group.</p>}
            </div>
            <form className="chat-form" onSubmit={sendChatMessage}>
              <input aria-label="Message to your group" value={chatText} onChange={(event) => setChatText(event.target.value)} maxLength={500} placeholder="Write a message…" />
              <button className="primary-button" disabled={sendingChat || !chatText.trim()}>{sendingChat ? "Sending…" : "Send"}</button>
            </form>
            <p className="chat-note">Only people who joined this room can read or send messages. Messages are deleted when the room expires.</p>
          </section>}
        </div>
      </div>
    </section>}
    <footer><span>Made for plans that bring people together.</span><span>Qloo insights show group taste patterns, not guarantees.</span></footer>
  </main>;
}

function PlanActivity({ items }: { items: PlanActivityItem[] }) {
  return <details className="panel activity-panel" open>
    <summary><span><b>Planning activity</b><small>Actual Qloo calls, filtering, and selection evidence</small></span><span>{items.length} steps</span></summary>
    <ol>{items.map((item) => <li key={item.id}>
      <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time>
      <span>{item.summary}</span>
    </li>)}</ol>
  </details>;
}

function RoomSummary({ room }: { room: Room }) {
  return <section className="panel roster-panel"><div className="roster-title"><h3>{room.me ? "Your people" : "Room preview"}</h3><span>{room.memberCount}/6</span></div>
    {room.me
      ? <div className="member-list">{room.members.map((member, index) => <div className="member-row" key={member.id}><span className={`avatar avatar-${index % 5}`}>{member.nickname.slice(0, 1).toUpperCase()}</span><span className="member-name">{member.nickname}{member.isHost && <small>HOST</small>}</span><span className={member.ready ? "status-ready" : member.hasChatted ? "status-chatting" : "status-waiting"}>{member.ready ? "Ready ✓" : member.hasChatted ? "Chatting" : "Adding…"} </span></div>)}</div>
      : <p>Join to see the roster, favorites, and plan.</p>}
    <div className="room-categories"><span>PLANNING</span>{room.categories.map((item) => <span className="mini-category" key={item}>{categoryInfo[item].icon} {categoryInfo[item].label}</span>)}</div>
    <div className="expiry-note">🔒 Private room · expires in 3 days</div>
  </section>;
}

function PlanView({ room, picks, onVote }: { room: Room; picks: Pick[]; onVote: (id: string, direction: "up" | "down") => void }) {
  return <div className="plan-stack">
    <div className="plan-intro"><span className="plan-badge">PLAN {String(room.planVersion).padStart(2, "0")}</span><p>These picks connect your group’s favorites. Vote to show what feels right.</p></div>
    {room.categories.map((category) => <section className="category-plan" key={category}>
      <div className="category-title"><span>{categoryInfo[category].icon}</span><h2>{categoryInfo[category].label}</h2><i /></div>
      {picks.filter((pick) => pick.category === category).length === 0
        ? <p className="category-empty-note">No confirmed favorites matched this category, so Qloo could not create recommendations for it.</p>
        : picks.filter((pick) => pick.category === category).map((pick, index) => <article className="pick-card" key={pick.pickId}>
        <div className="pick-top"><span className="pick-number">0{index + 1}</span><div className="pick-main"><h3>{pick.qloo.name}</h3><p>{pick.agent.blurb}</p></div><div className="overlap-score"><strong>{pick.qloo.overlapScore}%</strong><span>taste overlap</span></div></div>
        <div className="provenance"><div className="provenance-label">QLOO · GROUP TASTE</div><div className="meter">{room.members.map((member) => <span key={member.id} title={`${member.nickname}: ${Math.round((pick.qloo.memberAffinity[member.id] ?? 0) * 100)}%`} className={pick.qloo.memberAffinity[member.id] ? "meter-on" : ""} />)}</div><small>Normalized group affinity · everyone has a voice</small></div>
        <div className="provenance ai-provenance"><div className="provenance-label">AI · WHY IT COULD FIT</div>{pick.agent.fallback && <span className="fallback-label">Grounded fallback</span>}<ul>{room.members.map((member) => <li key={member.id}><span className="reason-avatar">{member.nickname.slice(0, 1).toUpperCase()}</span><span><b>{member.nickname}</b> {pick.agent.reasons[member.id] ?? "A shared taste connection is still being checked."}</span></li>)}</ul></div>
        {room.me && <div className="vote-row"><span>Would you pick this?</span><button className={pick.votes.mine === "up" ? "voted" : ""} onClick={() => onVote(pick.pickId, "up")}>👍 <b>{pick.votes.up}</b></button><button className={pick.votes.mine === "down" ? "voted" : ""} onClick={() => onVote(pick.pickId, "down")}>👎 <b>{pick.votes.down}</b></button></div>}
      </article>)}
    </section>)}
    <p className="score-disclaimer">Taste overlap reflects aggregate Qloo recommendation affinity — not a promise that anyone will enjoy a pick.</p>
  </div>;
}
