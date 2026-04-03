import { expect, test } from '@playwright/test';

const SUMMARY_HISTORY_KEY = 'studyhub-summary-history-v1';
const WORKSPACE_STATE_KEY = 'workspaceStateByAccount';
const SEEDED_SHARE_TOKEN = 'graph-share-token';

const SEEDED_WORKSPACE_STORE = {
  alice: {
    activeWorkspaceId: 'ws-e2e',
    workspaces: [
      {
        id: 'ws-e2e',
        name: 'E2E Workspace',
        plan: 'Free',
        members: ['alice'],
      },
    ],
  },
};

const SEEDED_SUMMARY_STORE = {
  'alice::ws-e2e': [
    {
      id: 'summary-seeded-graph-notes',
      docId: 1,
      title: 'Graph Notes',
      fileType: 'txt',
      summary: 'Graph traversal review covering BFS, DFS, and shortest-path thinking.',
      keywords: ['graph', 'bfs', 'dfs'],
      keySentences: [
        'Graph traversal often starts with BFS or DFS.',
        'Shortest-path problems depend on graph structure and weights.',
      ],
      summarySource: 'fallback',
      summaryNote: 'Seeded summary for Playwright export coverage.',
      summaryLength: 'medium',
      chunkCount: 1,
      mergeRounds: 0,
      refreshedFromFile: false,
      generatedAt: '2026-04-03T12:00:00.000Z',
    },
  ],
};

async function loginAsAlice(page) {
  await page.goto('/#/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.locator('#login-username').fill('alice');
  await page.locator('#login-password').fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/#/');
  await expect(page.locator('.notion-top-summary-btn')).toBeVisible();
}

async function seedHomeStorage(page) {
  await page.addInitScript(
    ({ workspaceStore, summaryStore, workspaceKey, summaryKey }) => {
      window.localStorage.setItem(workspaceKey, JSON.stringify(workspaceStore));
      window.localStorage.setItem(summaryKey, JSON.stringify(summaryStore));
    },
    {
      workspaceStore: SEEDED_WORKSPACE_STORE,
      summaryStore: SEEDED_SUMMARY_STORE,
      workspaceKey: WORKSPACE_STATE_KEY,
      summaryKey: SUMMARY_HISTORY_KEY,
    }
  );
}

test('home summary result modal shows export actions and PDF export downloads', async ({ page }) => {
  await seedHomeStorage(page);
  await loginAsAlice(page);

  await page.locator('.notion-top-summary-btn').click();
  await expect(page.getByRole('dialog', { name: 'Document Summary Center' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Summary' }).click();

  const summaryModal = page.getByRole('dialog', { name: 'Summary Result' });
  await expect(summaryModal).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Copy Summary' })).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Export TXT' })).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Export PDF' })).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Share by Email' })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    summaryModal.getByRole('button', { name: 'Export PDF' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^studyhub-summary-\d{4}-\d{2}-\d{2}\.pdf$/);
});

test('document detail summary actions stay available and PDF export downloads', async ({ page }) => {
  await loginAsAlice(page);

  await page.goto('/#/document/1');
  await expect(page.locator('.document-detail-card h1')).toHaveText('Graph Notes');

  const summarizeResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/analyze-text') &&
      response.request().method() === 'POST' &&
      response.ok()
  );
  await page.getByRole('button', { name: 'Summarize Document' }).click();
  await summarizeResponse;

  const detailCard = page.locator('.document-detail-card');
  await expect(detailCard.getByRole('button', { name: 'Copy Summary' })).toBeVisible();
  await expect(detailCard.getByRole('button', { name: 'Export TXT' })).toBeVisible();
  await expect(detailCard.getByRole('button', { name: 'Export PDF' })).toBeVisible();
  await expect(detailCard.getByRole('button', { name: 'Share by Email' })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    detailCard.getByRole('button', { name: 'Export PDF' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^studyhub-summary-\d{4}-\d{2}-\d{2}\.pdf$/);
});

test('public share link opens document view without sign in', async ({ page }) => {
  await page.goto(`/#/shared/${SEEDED_SHARE_TOKEN}`);

  await expect(page.getByText('Shared Document')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download Shared File' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In For Full Access' })).toBeVisible();
  await expect(page.locator('.document-detail-card h1')).toHaveText('Graph Notes');
  await expect(page.locator('.document-detail-card')).toContainText('graph traversal bfs dfs shortest path');
});
