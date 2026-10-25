import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Category } from "@taste-bridge/shared";

type Favorite = { qlooId: string; name: string; entityType: string };
type Member = { id: string; nickname: string; isHost: boolean; ready: boolean; favorites: Favorite[] };
type ChatMessage = { id: string; memberId: string; nickname: string; text: string; createdAt: number };
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
  picks: Pick[];
  chatMessages: ChatMessage[];
  me: { memberId: string; isHost: boolean; ready: boolean } | null;
};
type SearchResult = { id: string; name: string; entityType: string; subtitle: string };
type FavoriteType = Category | "tag";
const categoryInfo: Record<Category, { label: string; icon: string; entityType: string }> = {
  dining: { label: "Dinner", icon: "🍜", entityType: "place" },
  music: { label: "Music", icon: "🎧", entityType: "artist" },
  film_tv: { label: "Movie night", icon: "🎬", entityType: "movie" },
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { "Content-Type": "application/json", ...init?.headers } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "Something went wrong.");
  return payload as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export default function App() {
  const [room, setRoom] = useState<Room | null>(null);
  const [roomId, setRoomId] = useState(() => location.pathname.match(/^\/r\/([A-Za-z0-9_-]{8,32})$/)?.[1] ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nickname, setNickname] = useState("");
  const [city, setCity] = useState("");
  const [categories, setCategories] = useState<Category[]>(["dining", "music", "film_tv"]);
  const [searchCategory, setSearchCategory] = useState<FavoriteType>("music");
  const [searchText, setSearchText] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [linkCopied, setLinkCopied] = useState(false);
  const [chatText, setChatText] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const chatMessagesRef = useRef<HTMLDivElement>(null);

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
    if (room?.me) setFavorites(room.members.find((member) => member.id === room.me?.memberId)?.favorites ?? []);
  }, [room]);
  useEffect(() => {
    const container = chatMessagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [room?.chatMessages]);

  const changeCategories = (category: Category) => setCategories((current) =>
    current.includes(category) ? current.filter((item) => item !== category) : [...current, category]);
  const createRoom = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await request<{ room: Room }>("/api/rooms", json("POST", { nickname, categories, city: categories.includes("dining") ? city : null }));
      setRoom(response.room); setRoomId(response.room.id); history.pushState({}, "", `/r/${response.room.id}`);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
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
  const toggleFavorite = (result: SearchResult) => setFavorites((current) => {
    if (current.some((item) => item.qlooId === result.id)) return current.filter((item) => item.qlooId !== result.id);
    if (current.length >= 4) return current;
    return [...current, { qlooId: result.id, name: result.name, entityType: result.entityType }];
  });
  const saveFavorites = async () => {
    if (!roomId) return; setBusy(true); setError("");
    try {
      await request(`/api/rooms/${roomId}/favorites`, json("PUT", { qlooIds: favorites.map((item) => item.qlooId) }));
      await loadRoom(roomId);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const makePlan = async () => {
    if (!roomId) return; setBusy(true); setError("");
    try { await request(`/api/rooms/${roomId}/plan`, json("POST", {})); await loadRoom(roomId); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
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
  const planAvailable = Boolean(room?.planVersion && room.picks.length > 0);
  const sortedPicks = useMemo(() => room?.picks ?? [], [room]);

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="/" onClick={(event) => { event.preventDefault(); history.pushState({}, "", "/"); setRoomId(null); setRoom(null); setError(""); }}>
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
        <p className="fine-print">No account needed · Rooms expire after 3 days</p>
      </form>
    </section> : !room ? <div className="loading-card"><span className="loader" />Opening your room…</div> : !room.me ? <section className="join-layout">
      <div><p className="eyebrow">ROOM INVITE</p><h1>Come on in.</h1><p className="hero-intro">Join this private room to see the group and help find a plan.</p><RoomSummary room={room} /></div>
      {room.status === "gathering"
        ? <form className="panel join-panel" onSubmit={joinRoom}><span className="step">02</span><h2>Join the room</h2><label>Your nickname<input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={24} required autoFocus placeholder="A name your friends know" /></label><button className="primary-button full" disabled={busy}>{busy ? "Joining…" : "Join and add favorites →"}</button></form>
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
            <div className="panel-heading"><span className="step">03</span><div><h2>Your favorites</h2><p>Choose 2–4 things you genuinely like.</p></div></div>
            {me?.ready && <div className="ready-banner">Your favorites are in ✓ <button className="text-button" onClick={() => setFavorites(me.favorites)}>Edit</button></div>}
            <div className="favorite-chips">{favorites.map((item) => <button key={item.qlooId} onClick={() => setFavorites((current) => current.filter((f) => f.qlooId !== item.qlooId))}>{item.name}<span>×</span></button>)}</div>
            <form className="search-form" onSubmit={search}>
              <select aria-label="Favorite type" value={searchCategory} onChange={(e) => setSearchCategory(e.target.value as FavoriteType)}><option value="tag">Cuisine / style</option>{(Object.keys(categoryInfo) as Category[]).map((item) => <option value={item} key={item}>{categoryInfo[item].label}</option>)}</select>
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
            <button className="primary-button full" disabled={busy || room.status === "generating" || room.members.length < 3 || readyCount !== room.members.length} onClick={makePlan}>{room.status === "generating" ? "Finding your overlap…" : planAvailable ? "Find new picks ↻" : "Make our plan ✨"}</button>
            {room.planStatus === "failed" && <p className="inline-error">The latest plan attempt failed. You can try again.</p>}
          </section>}
        </aside>
        <div className="main-column">{planAvailable ? <><PlanView room={room} picks={sortedPicks} onVote={vote} />{room.status === "generating" && <p className="score-disclaimer">Finding fresh picks. Your current plan stays visible until the new one is ready.</p>}</> : <section className="panel waiting-panel"><div className="waiting-illustration">🪄</div><p className="eyebrow">{room.status === "generating" ? "WORKING ON IT" : "THE MAGIC HAPPENS TOGETHER"}</p><h2>{room.status === "generating" ? "Finding your overlap…" : room.status === "failed" ? "We couldn’t make that plan yet." : "First, add your favorites."}</h2><p>Once three or more friends confirm what they love, we’ll find the shared thread — with picks and reasons for each person.</p><div className="waiting-steps"><span>01 <b>Add favorites</b></span><span>02 <b>Invite friends</b></span><span>03 <b>Make a plan</b></span></div></section>}
          {room.me && <section className="panel chat-panel">
            <div className="chat-heading"><div><p className="eyebrow">ROOM CHAT</p><h2>Talk it out</h2></div><span>Messages stay with this room</span></div>
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

function RoomSummary({ room }: { room: Room }) {
  return <section className="panel roster-panel"><div className="roster-title"><h3>{room.me ? "Your people" : "Room preview"}</h3><span>{room.memberCount}/6</span></div>
    {room.me
      ? <div className="member-list">{room.members.map((member, index) => <div className="member-row" key={member.id}><span className={`avatar avatar-${index % 5}`}>{member.nickname.slice(0, 1).toUpperCase()}</span><span className="member-name">{member.nickname}{member.isHost && <small>HOST</small>}</span><span className={member.ready ? "status-ready" : "status-waiting"}>{member.ready ? "Ready ✓" : "Adding…"} </span></div>)}</div>
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
      {picks.filter((pick) => pick.category === category).map((pick, index) => <article className="pick-card" key={pick.pickId}>
        <div className="pick-top"><span className="pick-number">0{index + 1}</span><div className="pick-main"><h3>{pick.qloo.name}</h3><p>{pick.agent.blurb}</p></div><div className="overlap-score"><strong>{pick.qloo.overlapScore}%</strong><span>taste overlap</span></div></div>
        <div className="provenance"><div className="provenance-label">QLOO · GROUP TASTE</div><div className="meter">{room.members.map((member) => <span key={member.id} title={`${member.nickname}: ${Math.round((pick.qloo.memberAffinity[member.id] ?? 0) * 100)}%`} className={pick.qloo.memberAffinity[member.id] ? "meter-on" : ""} />)}</div><small>Normalized group affinity · everyone has a voice</small></div>
        <div className="provenance ai-provenance"><div className="provenance-label">AI · WHY IT COULD FIT</div>{pick.agent.fallback && <span className="fallback-label">Grounded fallback</span>}<ul>{room.members.map((member) => <li key={member.id}><span className="reason-avatar">{member.nickname.slice(0, 1).toUpperCase()}</span><span><b>{member.nickname}</b> {pick.agent.reasons[member.id] ?? "A shared taste connection is still being checked."}</span></li>)}</ul></div>
        {room.me && <div className="vote-row"><span>Would you pick this?</span><button className={pick.votes.mine === "up" ? "voted" : ""} onClick={() => onVote(pick.pickId, "up")}>👍 <b>{pick.votes.up}</b></button><button className={pick.votes.mine === "down" ? "voted" : ""} onClick={() => onVote(pick.pickId, "down")}>👎 <b>{pick.votes.down}</b></button></div>}
      </article>)}
    </section>)}
    <p className="score-disclaimer">Taste overlap reflects aggregate Qloo recommendation affinity — not a promise that anyone will enjoy a pick.</p>
  </div>;
}
