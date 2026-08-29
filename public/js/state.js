export const UI_STATE = {
  thread: 'codex-mobile-thread',
  tab: 'codex-mobile-tab',
  draft: 'codex-mobile-draft',
};

export const DOCUMENT_KINDS = new Set(['markdown', 'office', 'pdf']);
export const DOCUMENT_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.pdf', '.txt', '.csv', '.tsv', '.rtf',
  '.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp',
]);
export const THREAD_CACHE_MAX = 6;
export const CHUNKED_TURN_THRESHOLD = 12;
export const CHUNKED_ITEM_THRESHOLD = 80;
export const CHUNK_TURNS_PER_FRAME = 8;
export const MAIN_ITEM_TYPES = new Set(['userMessage', 'agentMessage', 'plan', 'structuredPlan']);

export const state = {
  bootstrap: null,
  projectBrowser: null,
  currentProject: localStorage.getItem('codex-mobile-project') || null,
  threads: [],
  threadsNextCursor: null,
  threadsLoadingMore: false,
  threadsScopeLoading: false,
  threadListScopeKey: null,
  threadCollections: new Map(),
  threadSearch: '',
  threadScope: 'all',
  threadFavoriteOnly: false,
  threadFilter: 'all',
  threadRuntimeById: new Map(),
  favoriteThreads: [],
  currentThread: null,
  turns: [],
  activeTurnId: null,
  approvals: new Map(),
  resolvingApprovalIds: new Set(),
  resolvedApprovalIds: new Set(),
  artifacts: [],
  artifactsThreadId: null,
  artifactsTotal: 0,
  artifactsNextOffset: null,
  artifactsLoadingMore: false,
  artifactsHistoryPending: false,
  artifactSearchResults: null,
  artifactSearchTotal: 0,
  artifactSearchNextOffset: null,
  artifactSearchLoading: false,
  artifactRequestSeq: 0,
  artifactQuery: '',
  artifactsVersion: 0,
  artifactsRenderedVersion: -1,
  artifactsRenderKey: '',
  timelineVersion: 0,
  timelineRenderedVersion: -1,
  turnsNextCursor: null,
  turnsLoadingOlder: false,
  pinnedToBottom: true,
  threadCache: new Map(),
  threadLoadSeq: 0,
  threadOpenedAt: null,
  questionCursor: 0,
  selectedMentions: [],
  currentArtifact: null,
  threadAction: null,
  threadCopy: null,
  handoff: null,
  accountStatus: null,
  accountStatusLoading: false,
  events: null,
  backendSwitching: false,
  mode: localStorage.getItem('codex-mobile-mode') === 'plan' ? 'plan' : 'default',
  theme: localStorage.getItem('codex-mobile-theme') === 'light' ? 'light' : 'dark',
  approvalsReviewer: (() => {
    const stored = localStorage.getItem('codex-mobile-approvals-reviewer');
    return stored === 'never' || stored === 'user' || stored === 'auto_review' ? stored : 'auto_review';
  })(),
  model: localStorage.getItem('codex-mobile-model') || null,
  effort: localStorage.getItem('codex-mobile-effort') || null,
  turnModes: new Map(),
  pendingTurnMode: null,
};
