import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completedRuntimeActivity,
  latestCompletedTurn,
  planDecisionReady,
} from '../public/js/turn-state.js';

const finalPlan = {
  id: 'turn-plan',
  status: 'completed',
  items: [{ id: 'answer', type: 'agentMessage', text: '完整实施方案' }],
};

test('plan decision uses completion phase even without plan tool items', () => {
  assert.equal(planDecisionReady({
    turns: [finalPlan],
    turnModes: new Map(),
    activity: { lastCompletionTurnId: finalPlan.id, lastCompletionPhase: 'plan' },
  }), true);
  assert.equal(planDecisionReady({
    turns: [finalPlan],
    turnModes: new Map([[finalPlan.id, 'default']]),
    activity: { lastCompletionTurnId: finalPlan.id, lastCompletionPhase: 'default' },
  }), false);
});

test('legacy explicit plan items remain compatible and only the latest completed turn is considered', () => {
  const legacy = { id: 'legacy', status: 'completed', items: [{ id: 'plan', type: 'plan', text: '旧方案' }] };
  assert.equal(planDecisionReady({ turns: [legacy], turnModes: new Map(), activity: null }), true);
  assert.equal(latestCompletedTurn([legacy, finalPlan]), finalPlan);
});

test('completed runtime activity preserves mode and deduplicates terminal events', () => {
  const previous = {
    threadId: 'thread-1', status: 'planning', phase: 'plan', activeTurnId: 'turn-plan', unreadCount: 2,
  };
  const completed = completedRuntimeActivity(previous, {
    threadId: 'thread-1', turnId: 'turn-plan', status: 'completed', at: 100,
  });
  assert.equal(completed.lastCompletionPhase, 'plan');
  assert.equal(completed.lastCompletionTurnId, 'turn-plan');
  assert.equal(completed.unreadCount, 3);
  const duplicate = completedRuntimeActivity(completed, {
    threadId: 'thread-1', turnId: 'turn-plan', status: 'completed', at: 110,
  });
  assert.equal(duplicate.unreadCount, 3);
});
