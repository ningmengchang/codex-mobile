export function normalizeTurnPhase(value) {
  return value === 'plan' || value === 'default' ? value : null;
}

export function latestCompletedTurn(turns) {
  for (let index = (turns?.length ?? 0) - 1; index >= 0; index -= 1) {
    if (turns[index]?.status === 'completed') return turns[index];
  }
  return null;
}

export function planDecisionReady({ turns, turnModes, activity }) {
  const turn = latestCompletedTurn(turns);
  if (!turn) return false;
  const items = turn.items ?? [];
  const hasPlanItem = items.some((item) => item.type === 'plan' || item.type === 'structuredPlan');
  const hasFinalAnswer = items.some((item) => (
    item.type === 'agentMessage' && String(item.text ?? '').trim().length > 0
  ));
  const completedAsPlan = turnModes?.get(turn.id) === 'plan'
    || (activity?.lastCompletionTurnId === turn.id && activity?.lastCompletionPhase === 'plan');

  // Older stored conversations do not have completion-phase metadata. Their explicit
  // plan items remain a safe compatibility signal until those histories are rewritten.
  return completedAsPlan ? hasPlanItem || hasFinalAnswer : hasPlanItem;
}

export function terminalActivityStatus(value) {
  const status = String(value ?? '').toLowerCase();
  if (status.includes('fail') || status.includes('error')) return 'failed';
  if (status.includes('interrupt') || status.includes('cancel') || status.includes('stop')) return 'interrupted';
  return 'completed';
}

export function completedRuntimeActivity(previous, { threadId, turnId, status, at = Date.now() }) {
  const alreadyTerminal = ['completed', 'failed', 'interrupted'].includes(previous?.status)
    && !previous?.activeTurnId;
  return {
    ...previous,
    threadId,
    status: terminalActivityStatus(status),
    phase: null,
    activeTurnId: null,
    lastCompletionTurnId: turnId ?? previous?.activeTurnId ?? previous?.lastCompletionTurnId ?? null,
    lastCompletionPhase: normalizeTurnPhase(previous?.phase) ?? previous?.lastCompletionPhase ?? null,
    unreadCount: alreadyTerminal ? (previous?.unreadCount ?? 0) : (previous?.unreadCount ?? 0) + 1,
    completedAt: at,
    updatedAt: at,
  };
}
