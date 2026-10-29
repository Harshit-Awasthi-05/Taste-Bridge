PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  categories TEXT NOT NULL,
  city_or_area TEXT,
  status TEXT NOT NULL DEFAULT 'gathering'
    CHECK (status IN ('gathering', 'generating', 'ready', 'failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rooms_expires ON rooms(expires_at);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL COLLATE NOCASE
    CHECK (length(nickname) BETWEEN 1 AND 24),
  token_hash TEXT NOT NULL,
  is_host INTEGER NOT NULL DEFAULT 0 CHECK (is_host IN (0, 1)),
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  joined_at INTEGER NOT NULL,
  UNIQUE (room_id, nickname)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_host_per_room
  ON members(room_id) WHERE is_host = 1;
CREATE INDEX IF NOT EXISTS idx_members_room ON members(room_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room_time
  ON chat_messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS favorites (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  qloo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'chat', 'demo')),
  PRIMARY KEY (member_id, qloo_id)
);

CREATE TABLE IF NOT EXISTS member_search_results (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  qloo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  subtitle TEXT,
  image_url TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'chat', 'demo')),
  searched_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, qloo_id)
);
CREATE INDEX IF NOT EXISTS idx_search_results_expiry
  ON member_search_results(searched_at);

CREATE TABLE IF NOT EXISTS plans (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  error_code TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS picks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('dining', 'music', 'film_tv', 'tv_show', 'books', 'podcasts')),
  rank INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'replaced')),
  created_version INTEGER NOT NULL,
  qloo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  qloo_tags TEXT NOT NULL,
  member_affinity TEXT NOT NULL,
  overlap_score REAL NOT NULL CHECK (overlap_score BETWEEN 0 AND 100),
  qloo_source TEXT NOT NULL,
  agent_blurb TEXT,
  agent_reasons TEXT,
  agent_model TEXT,
  agent_fallback INTEGER NOT NULL DEFAULT 0 CHECK (agent_fallback IN (0, 1)),
  UNIQUE (room_id, category, qloo_id)
);
CREATE INDEX IF NOT EXISTS idx_picks_room ON picks(room_id, state);

CREATE TABLE IF NOT EXISTS plan_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_activity_room_id
  ON plan_activity(room_id, id);

CREATE TABLE IF NOT EXISTS rejected_entities (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  qloo_id TEXT NOT NULL,
  rejected_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, category, qloo_id)
);

CREATE TABLE IF NOT EXISTS votes (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  pick_id TEXT NOT NULL REFERENCES picks(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, pick_id)
);

CREATE TABLE IF NOT EXISTS qloo_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qloo_cache_expires ON qloo_cache(expires_at);
