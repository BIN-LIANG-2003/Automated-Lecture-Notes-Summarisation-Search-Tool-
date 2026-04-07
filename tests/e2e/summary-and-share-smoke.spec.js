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
  const loginField = page.locator('#login-username');
  if (await loginField.isVisible().catch(() => false)) {
    await loginField.fill('alice');
    await page.locator('#login-password').fill('password123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/#/');
  } else {
    await page.waitForURL('**/#/');
  }
  await expect(page.locator('.notion-top-summary-btn')).toBeVisible();
}

async function goToMyFiles(page) {
  await expect(page.getByRole('button', { name: 'My Files' })).toBeVisible();
  await page.getByRole('button', { name: 'My Files' }).click();
  await expect(page.locator('#files-section')).toBeVisible();
  await expect(page.locator('#search-input')).toBeVisible();
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

async function installWindowOpenSpy(page) {
  await page.evaluate(() => {
    window.__studyhubWindowOpenCalls = [];
    window.open = (url, target, features) => {
      window.__studyhubWindowOpenCalls.push({
        url: String(url || ''),
        target: String(target || ''),
        features: String(features || ''),
      });
      return null;
    };
  });
}

async function expectMailtoOpen(page) {
  await page.waitForFunction(() => Array.isArray(window.__studyhubWindowOpenCalls) && window.__studyhubWindowOpenCalls.length > 0);
  return page.evaluate(() => window.__studyhubWindowOpenCalls[window.__studyhubWindowOpenCalls.length - 1]);
}

test('files workspace summary center opens summary result modal with export and email actions', async ({ page }) => {
  await seedHomeStorage(page);
  await loginAsAlice(page);
  await goToMyFiles(page);

  await page.locator('.notion-top-summary-btn').click();
  const summaryCenter = page.getByRole('dialog', { name: 'Document Summary Center' });
  await expect(summaryCenter).toBeVisible();
  await expect(summaryCenter.getByRole('button', { name: 'Open Summary' })).toBeVisible();
  await expect(summaryCenter.getByRole('button', { name: 'Copy Summary' })).toBeVisible();
  await expect(summaryCenter.getByRole('button', { name: 'Share by Email' })).toBeVisible();

  await installWindowOpenSpy(page);
  await summaryCenter.getByRole('button', { name: 'Share by Email' }).click();
  const summaryCenterMail = await expectMailtoOpen(page);
  expect(summaryCenterMail.url).toContain('mailto:');
  expect(summaryCenterMail.url).toContain('StudyHub%20Note%20Summary');

  await summaryCenter.getByRole('button', { name: 'Open Summary' }).click();
  const summaryModal = page.getByRole('dialog', { name: 'Summary Result' });
  await expect(summaryModal).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Copy Summary' })).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Export TXT' })).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Export PDF' })).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Share by Email' })).toBeVisible();

  const [txtDownload] = await Promise.all([
    page.waitForEvent('download'),
    summaryModal.getByRole('button', { name: 'Export TXT' }).click(),
  ]);
  expect(txtDownload.suggestedFilename()).toMatch(/^studyhub-summary-\d{4}-\d{2}-\d{2}\.txt$/);

  const [pdfDownload] = await Promise.all([
    page.waitForEvent('download'),
    summaryModal.getByRole('button', { name: 'Export PDF' }).click(),
  ]);
  expect(pdfDownload.suggestedFilename()).toMatch(/^studyhub-summary-\d{4}-\d{2}-\d{2}\.pdf$/);

  await summaryModal.getByRole('button', { name: 'Share by Email' }).click();
  const summaryModalMail = await expectMailtoOpen(page);
  expect(summaryModalMail.url).toContain('mailto:');
  expect(summaryModalMail.url).toContain('StudyHub%20Note%20Summary');
});

test('files detail pane summarize flow opens the current summary result modal', async ({ page }) => {
  await loginAsAlice(page);
  await goToMyFiles(page);

  await page.locator('#search-input').fill('graph');
  await page.locator('#search-btn').click();

  const graphCard = page.locator('.document-card', { hasText: 'Graph Notes' });
  await expect(graphCard).toBeVisible();
  await graphCard.getByRole('button', { name: 'View' }).click();
  await expect(page.locator('.document-detail-card h2')).toHaveText('Graph Notes');

  const summarizeResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/analyze-text') &&
      response.request().method() === 'POST' &&
      response.ok()
  );
  await page.locator('.document-detail-card').getByRole('button', { name: 'Summarize Document' }).click();
  await summarizeResponse;

  const summaryModal = page.getByRole('dialog', { name: 'Summary Result' });
  await expect(summaryModal).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Copy Summary' })).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Export TXT' })).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Export PDF' })).toBeVisible();
  await expect(summaryModal.getByRole('button', { name: 'Share by Email' })).toBeVisible();

  await installWindowOpenSpy(page);
  await summaryModal.getByRole('button', { name: 'Share by Email' }).click();
  const modalMail = await expectMailtoOpen(page);
  expect(modalMail.url).toContain('mailto:');
  expect(modalMail.url).toContain('StudyHub%20Note%20Summary');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    summaryModal.getByRole('button', { name: 'Export PDF' }).click(),
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
