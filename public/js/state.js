export const UI_STATE = {
  thread: 'codex-mobile-thread',
  tab: 'codex-mobile-tab',
  draft: 'codex-mobile-draft',
};

export const DELIVERABLE_KINDS = new Set(['markdown', 'office', 'pdf', 'html']);
export const DELIVERABLE_KEYWORDS = ['prd', '方案', '需求', '设计', '说明', '报告', 'spec', 'final', '最终', '汇总', 'combined', '清单', '接口'];
export const ARTIFACT_OTHER_PAGE = 50;
export const ARTIFACT_OTHER_STEP = 100;
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
  currentThread: null,
  turns: [],
  activeTurnId: null,
  approvals: new Map(),
  artifacts: [],
  artifactQuery: '',
  artifactOtherShown: ARTIFACT_OTHER_PAGE,
  artifactsVersion: 0,
  artifactsRenderedVersion: -1,
  artifactsRenderKey: '',
  timelineVersion: 0,
  timelineRenderedVersion: -1,
  turnsNextCursor: null,
  turnsLoadingOlder: false,
  dingtalkMessages: [],
  dingtalkCursor: null,
  dingtalkHasMore: false,
  dingtalkLoading: false,
  pendingCodexMessage: null,
  pinnedToBottom: true,
  threadCache: new Map(),
  threadLoadSeq: 0,
  threadOpenedAt: null,
  questionCursor: 0,
  selectedMentions: [],
  currentArtifact: null,
  threadAction: null,
  events: null,
  mode: localStorage.getItem('codex-mobile-mode') === 'plan' ? 'plan' : 'default',
  approvalsReviewer: (() => {
    const stored = localStorage.getItem('codex-mobile-approvals-reviewer');
    return stored === 'never' || stored === 'user' || stored === 'auto_review' ? stored : 'auto_review';
  })(),
  model: localStorage.getItem('codex-mobile-model') || null,
  effort: localStorage.getItem('codex-mobile-effort') || null,
  turnModes: new Map(),
  pendingTurnMode: null,
};
