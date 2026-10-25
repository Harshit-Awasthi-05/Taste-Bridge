export type Category = 'dining' | 'music' | 'film_tv';
export type RoomStatus = 'gathering' | 'generating' | 'ready' | 'failed';
export type PlanStatus = 'generating' | 'ready' | 'failed';

export interface QlooEnvelope<T = unknown> {
  status: 'ok' | 'empty' | 'needs_input' | 'partial' | 'degraded' | 'error';
  summary: string;
  results: T[];
  result_count: number;
  error?: {
    code: string;
    retryable: boolean;
    recovery: string;
  };
}

export interface QlooFavorite {
  qlooId: string;
  name: string;
  entityType: string;
}

export interface Member {
  id: string;
  roomId: string;
  nickname: string;
  favorites: QlooFavorite[];
  isHost: boolean;
  ready: boolean;
  favoriteCount: number;
}

export interface PlanPick {
  pickId: string;
  roomId: string;
  category: Category;
  rank: number;
  qloo: {
    entityId: string;
    name: string;
    type: string;
    tags: { id: string; name: string }[];
    memberAffinity: Record<string, number>;
    overlapScore: number;
    scoreMethod: string;
    source: {
      workflows: string[];
      fetchedAt: string;
      requestHash?: string;
    };
  };
  agent: {
    generatedBy: 'ai';
    model: string | null;
    fallback: boolean;
    blurb: string | null;
    reasons: { memberId: string; text: string }[];
  };
  votes: {
    up: number;
    down: number;
    mine: 'up' | 'down' | null;
  };
  state: 'active' | 'replaced';
}

export interface Vote {
  memberId: string;
  pickId: string;
  direction: 'up' | 'down';
}

export interface RoomState {
  id: string;
  categories: Category[];
  city: string | null;
  status: RoomStatus;
  createdAt: string;
  expiresAt: string;
  members: Member[];
  planVersion: number;
  me: { memberId: string; isHost: boolean; ready: boolean } | null;
}
