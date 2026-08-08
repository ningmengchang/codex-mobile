import { loadConfig } from '../server/config.mjs';
import { AppServerBridge } from '../server/app-server.mjs';

process.env.HOME = process.env.HOME || '/home/ningmengchang';
process.env.CODEX_HOME = process.env.CODEX_HOME || '/home/ningmengchang/.codex';

const threadId = process.argv[2]
  ?? '019fcd0d-9f2d-7642-90e8-00ad9b42317d';

const config = loadConfig({
  dataDir: '/tmp/codex-mobile-probe-data',
  cacheDir: '/tmp/codex-mobile-probe-cache',
  secretPath: '/tmp/codex-mobile-probe-secret',
});

const bridge = new AppServerBridge(config);
const summary = { threadId, steps: [] };

async function step(name, fn) {
  try {
    const result = await fn();
    summary.steps.push({ name, ok: true });
    return result;
  } catch (error) {
    summary.steps.push({
      name,
      ok: false,
      error: error.message,
      code: error.code ?? null,
      data: error.data ?? undefined,
    });
    return null;
  }
}

try {
  await bridge.start();
  const meta = await step('thread/read', () => bridge.request('thread/read', { threadId, includeTurns: false }, 120_000));
  if (meta) {
    summary.readRaw = {
      keys: Object.keys(meta),
      threadKeys: Object.keys(meta.thread ?? {}),
      turnsBackwardsCursor: meta.turnsBackwardsCursor ?? null,
      itemsBackwardsCursor: meta.itemsBackwardsCursor ?? null,
      turnsLength: meta.thread?.turns?.length ?? null,
      turnsNotLoaded: meta.thread?.turnsNotLoaded ?? null,
    };
    summary.thread = {
      name: meta.thread?.name ?? meta.name ?? null,
      turnsCount: meta.thread?.turns?.length ?? meta.turns?.length ?? null,
      hasTurns: Boolean(meta.thread?.turns ?? meta.turns),
    };
  }

  const resumed = await step('thread/resume', () => bridge.request('thread/resume', { threadId }, 120_000));
  if (resumed) {
    summary.resumeRaw = {
      keys: Object.keys(resumed),
      turnsBackwardsCursor: resumed.turnsBackwardsCursor ?? null,
      itemsBackwardsCursor: resumed.itemsBackwardsCursor ?? null,
      initialTurnsPageKeys: resumed.initialTurnsPage ? Object.keys(resumed.initialTurnsPage) : null,
      turnsLength: resumed.thread?.turns?.length ?? null,
      turnKeys: resumed.turn ? Object.keys(resumed.turn) : null,
    };
    summary.resumed = {
      hasThread: Boolean(resumed.thread),
      turnId: resumed.turn?.id ?? resumed.turnId ?? null,
      hasInitialTurnsPage: Boolean(resumed.initialTurnsPage),
    };
  }

  const resumeNoTurns = await step('thread/resume(includeTurns=false)', () => bridge.request('thread/resume', {
    threadId,
    includeTurns: false,
  }, 120_000));
  if (resumeNoTurns) {
    summary.resumeNoTurns = {
      turnsLength: resumeNoTurns.thread?.turns?.length ?? null,
      hasTurnsKey: Object.prototype.hasOwnProperty.call(resumeNoTurns.thread ?? {}, 'turns'),
      initialTurnsPageKeys: resumeNoTurns.initialTurnsPage ? Object.keys(resumeNoTurns.initialTurnsPage) : null,
      turnsBackwardsCursor: resumeNoTurns.turnsBackwardsCursor ?? null,
      itemsBackwardsCursor: resumeNoTurns.itemsBackwardsCursor ?? null,
    };
  }

  const resumeExclude = await step('thread/resume(excludeTurns=true)', () => bridge.request('thread/resume', {
    threadId,
    excludeTurns: true,
  }, 120_000));
  if (resumeExclude) {
    summary.resumeExclude = {
      turnsLength: resumeExclude.thread?.turns?.length ?? null,
      hasTurnsKey: Object.prototype.hasOwnProperty.call(resumeExclude.thread ?? {}, 'turns'),
      initialTurnsPageKeys: resumeExclude.initialTurnsPage ? Object.keys(resumeExclude.initialTurnsPage) : null,
    };
  }


  const resumedPage = await step('thread/resume(initialTurnsPage)', () => bridge.request('thread/resume', {
    threadId,
    initialTurnsPage: { pageSize: 5, sortDirection: 'desc', itemsView: 'full' },
  }, 120_000));
  if (resumedPage) {
    const page = resumedPage.initialTurnsPage;
    summary.resumePageRaw = {
      pageRaw: JSON.stringify(page ?? null).slice(0, 2000),
      turnsBackwardsCursor: resumedPage.turnsBackwardsCursor ?? null,
      itemsBackwardsCursor: resumedPage.itemsBackwardsCursor ?? null,
      threadTurnsLength: resumedPage.thread?.turns?.length ?? null,
    };
    summary.resumePage = {
      turns: page?.turns?.length ?? null,
      nextCursor: page?.nextCursor ?? null,
      backwardsCursor: page?.turnsBackwardsCursor ?? resumedPage.turnsBackwardsCursor ?? null,
      itemsBackwardsCursor: resumedPage.itemsBackwardsCursor ?? null,
      firstTurnId: page?.turns?.[0]?.id ?? null,
      firstTurnItems: page?.turns?.[0]?.items?.length ?? null,
    };
    const backwards = await step('turns/list(backwards)', () => bridge.request('thread/turns/list', {
      threadId,
      cursor: summary.resumePage.backwardsCursor,
      pageSize: 5,
      sortDirection: 'desc',
      itemsView: 'full',
    }, 120_000));
    if (backwards) {
      summary.backwardsPage = {
        turns: (backwards.turns ?? []).length,
        nextCursor: backwards.nextCursor ?? null,
        backwardsCursor: backwards.turnsBackwardsCursor ?? null,
        firstTurnId: backwards.turns?.[0]?.id ?? null,
      };
    }
  }

  const ascPage = await step('turns/list(asc)', () => bridge.request('thread/turns/list', {
    threadId,
    pageSize: 5,
    sortDirection: 'asc',
    itemsView: 'full',
  }, 120_000));
  if (ascPage) {
    summary.ascPage = {
      turns: (ascPage.turns ?? []).length,
      nextCursor: ascPage.nextCursor ?? null,
      backwardsCursor: ascPage.turnsBackwardsCursor ?? null,
      firstTurnId: ascPage.turns?.[0]?.id ?? null,
      lastTurnId: ascPage.turns?.at(-1)?.id ?? null,
    };
  }

  const firstCursor = summary.firstPage?.nextCursor ?? summary.resumePage?.nextCursor ?? null;
  const cursorPage = await step('turns/list(cursor-desc)', () => bridge.request('thread/turns/list', {
    threadId,
    cursor: firstCursor,
    pageSize: 5,
    sortDirection: 'desc',
    itemsView: 'full',
  }, 120_000));
  if (cursorPage) {
    summary.cursorPage = {
      raw: JSON.stringify(cursorPage).slice(0, 1500),
      turns: (cursorPage.turns ?? []).length,
      nextCursor: cursorPage.nextCursor ?? null,
      backwardsCursor: cursorPage.turnsBackwardsCursor ?? null,
      firstTurnId: cursorPage.turns?.[0]?.id ?? null,
    };
  }

  const fullParams = { threadId, pageSize: 5, sortDirection: 'desc', itemsView: 'full' };
  const page = await step('turns/list(full)', () => bridge.request('thread/turns/list', fullParams, 120_000));
  if (!page) {
    const basicParams = { threadId, pageSize: 5, sortDirection: 'desc' };
    const basic = await step('turns/list(basic)', () => bridge.request('thread/turns/list', basicParams, 120_000));
    summary.branch = basic ? 'A' : 'B';
    if (basic) {
      summary.firstPage = {
        turns: (basic.turns ?? []).length,
        nextCursor: basic.nextCursor ?? null,
        backwardsCursor: basic.turnsBackwardsCursor ?? null,
        firstTurnId: basic.turns?.[0]?.id ?? null,
        itemsView: 'summary',
      };
    }
  } else {
    summary.branch = 'A';
    summary.firstPageRaw = JSON.stringify(page).slice(0, 800);
    summary.firstPage = {
      turns: (page.turns ?? []).length,
      nextCursor: page.nextCursor ?? null,
      backwardsCursor: page.turnsBackwardsCursor ?? null,
      firstTurnId: page.turns?.[0]?.id ?? null,
      itemsView: 'full',
      firstTurnItems: page.turns?.[0]?.items?.length ?? null,
    };
  }
} catch (error) {
  summary.fatal = error.message;
} finally {
  await bridge.stop().catch(() => {});
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = summary.branch === 'A' ? 0 : 1;
