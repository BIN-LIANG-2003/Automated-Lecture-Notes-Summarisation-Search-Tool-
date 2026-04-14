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
    const loginResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/auth/login') &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const loginResponse = await loginResponsePromise;
    const loginBody = await loginResponse.text().catch(() => '');
    expect(
      loginResponse.ok(),
      `login failed: ${loginResponse.status()} ${loginBody}`
    ).toBeTruthy();
    await page.waitForFunction(() => !window.location.hash.startsWith('#/login'), undefined, {
      timeout: 15_000,
    });
  }
  await expect(page.locator('.notion-shell')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#main')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /Summaries \(\d+\)/ })).toBeVisible({
    timeout: 15_000,
  });
}

async function goToMyFiles(page) {
  await expect(page.getByRole('button', { name: 'Notes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
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

async function mockDocumentEmailShare(page, expectedRecipient = 'classmate@example.com', options = {}) {
  const includeShareUrl = options.includeShareUrl !== false;
  await page.route('**/api/documents/1/email-share', async (route) => {
    const requestBody = route.request().postDataJSON();
    expect(requestBody.recipient_email).toBe(expectedRecipient);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sent: true,
        message: `Shared note email sent to ${expectedRecipient}.`,
        recipient_email: expectedRecipient,
        expires_at: '2026-04-19T12:00:00Z',
        share: {
          ...(includeShareUrl
            ? { share_url: 'http://127.0.0.1:5001/#/shared/email-share-smoke-token' }
            : {}),
          token: 'email-share-smoke-token',
          expiry_days: 7,
        },
      }),
    });
  });
}

async function mockShareLinksList(page, count = 18) {
  const items = Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const expired = number % 5 === 0;
    const revoked = number % 4 === 0;
    return {
      id: number,
      token: `long-share-token-${number}`,
      share_url: `http://127.0.0.1:5001/#/shared/long-share-token-${number}`,
      status: revoked ? 'revoked' : 'active',
      expires_at: `2026-04-${String(10 + (number % 15)).padStart(2, '0')}T12:00:00Z`,
      created_at: '2026-04-01T12:00:00Z',
      is_expired: expired,
    };
  });
  await page.route('**/api/documents/1/share-links?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items }),
    });
  });
}

test('files workspace summary center opens summary result modal with export and email actions', async ({ page }) => {
  await seedHomeStorage(page);
  await loginAsAlice(page);
  await goToMyFiles(page);

  const topbarActions = page.locator('.notion-top-actions');
  await expect(topbarActions.locator('.notion-top-pill')).toHaveCount(0);
  await expect(topbarActions.getByRole('button', { name: 'Feedback' })).toBeVisible();

  await page.getByRole('button', { name: /Summaries \(\d+\)/ }).click();
  const summaryCenter = page.getByRole('dialog', { name: 'Summaries' });
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
  await page.route('**/api/analyze-text', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        summary: 'Graph traversal review covering BFS, DFS, and shortest-path thinking.',
        keywords: ['graph', 'bfs', 'dfs'],
        key_sentences: ['Graph traversal often starts with BFS or DFS.'],
        summary_source: 'playwright',
        summary_note: 'Mocked deterministic summary for E2E coverage.',
        cache_hit: false,
      }),
    });
  });
  await loginAsAlice(page);
  await goToMyFiles(page);

  const searchInput = page.locator('#search-input');
  await searchInput.fill('graph');
  await searchInput.press('Enter');

  const graphCard = page.locator('.document-card', { hasText: 'Graph Notes' });
  await expect(graphCard).toBeVisible();
  await graphCard.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('.document-detail-card h2')).toHaveText('Graph Notes');

  const summarizeButton = page
    .locator('.document-detail-card')
    .getByRole('button', { name: /^Summarize(?: Note)?$/ });
  await expect(summarizeButton).toBeVisible({ timeout: 15_000 });
  await expect(summarizeButton).toBeEnabled({ timeout: 15_000 });
  const summarizeResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/analyze-text') &&
      response.request().method() === 'POST' &&
      response.ok()
  );
  await Promise.all([summarizeResponse, summarizeButton.click()]);

  const summaryModal = page.getByRole('dialog', { name: 'Summary Result' });
  await expect(summaryModal).toBeVisible({ timeout: 15_000 });
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

test('files list shows OCR-needed PDFs as action required', async ({ page }) => {
  await page.route(/\/api\/documents\?.*/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 77,
            filename: 'scanned-notes.pdf',
            title: 'Scanned Notes',
            uploaded_at: '2026-04-03T12:00:00.000Z',
            file_type: 'pdf',
            content: '',
            content_html: '',
            username: 'alice',
            tags: '',
            category: 'Computer Science',
            workspace_id: 'ws-e2e',
            processing_status: 'needs_ocr',
            processing_error: 'No selectable text was found in this PDF. OCR or a text-selectable PDF is required before summaries and search.',
            processed_at: '2026-04-03T12:00:00.000Z',
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
        has_more: false,
        facets: {
          tags: [],
          categories: ['Computer Science'],
          file_types: { pdf: 1 },
        },
      }),
    });
  });

  await loginAsAlice(page);
  await goToMyFiles(page);

  const scannedCard = page.locator('.document-card', { hasText: 'Scanned Notes' });
  await expect(scannedCard).toBeVisible();
  await expect(scannedCard).toContainText('OCR Needed');
  await expect(scannedCard).toContainText('No selectable text was found');
  await expect(scannedCard.getByRole('button', { name: 'Summarize' })).toBeDisabled();
});

test('home embedded reader exposes link management in the top bar', async ({ page }) => {
  await mockShareLinksList(page, 3);
  await loginAsAlice(page);
  await mockDocumentEmailShare(page);
  await goToMyFiles(page);

  const searchInput = page.locator('#search-input');
  await searchInput.fill('graph');
  await searchInput.press('Enter');

  const graphCard = page.locator('.document-card', { hasText: 'Graph Notes' });
  await expect(graphCard).toBeVisible();
  const shareLinksResponse = page.waitForResponse(
    (response) =>
      /\/api\/documents\/\d+\/share-links/.test(response.url()) &&
      response.request().method() === 'GET' &&
      response.ok()
  );
  await graphCard.getByRole('button', { name: 'Open' }).click();
  await shareLinksResponse;
  const embeddedReader = page.locator('.document-detail-card');
  await expect(embeddedReader.getByRole('heading', { name: 'Graph Notes' })).toBeVisible();
  await expect(embeddedReader.getByRole('heading', { name: 'Shared Links' })).toHaveCount(0);
  await expect(embeddedReader.getByRole('button', { name: 'Copy Link', exact: true })).toHaveCount(0);
  await expect(embeddedReader.getByRole('button', { name: 'Manage Links', exact: true })).toHaveCount(0);

  const topbarActions = page.locator('.notion-top-actions');
  await expect(topbarActions.getByRole('button', { name: 'Feedback' })).toBeVisible();
  const topbarManageLinks = topbarActions.getByRole('button', { name: 'Manage Links', exact: true });
  await expect(topbarManageLinks).toBeVisible({ timeout: 15_000 });
  await topbarManageLinks.click();

  const initialManageModal = page.getByRole('dialog', { name: 'Manage Links' });
  await expect(initialManageModal).toBeVisible();
  await expect(initialManageModal.locator('.document-detail-share-links-panel')).toBeVisible();
  await expect(initialManageModal.locator('.notion-doc-share-list li')).toHaveCount(3);
  await expect(initialManageModal).toContainText('long-share-token-1');
  await expect(initialManageModal).toContainText('long-share-token-2');
  await expect(initialManageModal).toContainText('long-share-token-3');
  await expect(initialManageModal.getByLabel('Recipient email')).toHaveCount(0);
  await initialManageModal.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog', { name: 'Manage Links' })).toHaveCount(0);

  await embeddedReader.getByRole('button', { name: 'Send', exact: true }).click();
  const sendModal = page.getByRole('dialog', { name: 'Send Note' });
  await expect(sendModal).toBeVisible();
  await expect(sendModal.getByRole('button', { name: 'Copy Link', exact: true })).toHaveCount(0);
  await expect(sendModal.getByRole('button', { name: 'Manage Links', exact: true })).toHaveCount(0);
  await sendModal.getByLabel('Recipient email').fill('classmate@example.com');
  await sendModal.getByRole('button', { name: 'Send Email' }).click();

  const successModal = page.getByRole('dialog', { name: 'Note Sent' });
  await expect(successModal).toBeVisible();
  await expect(successModal).toContainText('Sent to classmate@example.com');
  await expect(successModal.getByRole('button', { name: 'Copy Link' })).toBeVisible();
  await expect(successModal.getByRole('button', { name: 'Manage Links' })).toHaveCount(0);
});

test('document detail sharing defaults to send-by-email flow', async ({ page }) => {
  await loginAsAlice(page);
  await mockDocumentEmailShare(page);

  await page.goto('/#/document/1');
  await expect(page.locator('.document-detail-card h1')).toHaveText('Graph Notes');
  await expect(page.locator('.document-detail-share-card')).toHaveCount(0);
  await expect(page.getByText('Existing Links')).toHaveCount(0);

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sendModal = page.getByRole('dialog', { name: 'Send Note' });
  await expect(sendModal).toBeVisible();
  await sendModal.getByLabel('Recipient email').fill('classmate@example.com');
  await sendModal.getByLabel('Short message (optional)').fill('Please review this note before class.');
  await sendModal.getByLabel('Expiry days (optional)').fill('7');
  await sendModal.getByRole('button', { name: 'Send Email' }).click();

  const successModal = page.getByRole('dialog', { name: 'Note Sent' });
  await expect(successModal).toBeVisible();
  await expect(successModal).toContainText('Sent to classmate@example.com');
  await expect(successModal).toContainText(/until/i);
  await expect(successModal).not.toContainText('2026-04-19T12:00:00Z');
  await expect(successModal.getByRole('button', { name: 'Copy Link' })).toBeVisible();
  await expect(successModal.getByRole('button', { name: 'Manage Links' })).toHaveCount(0);
  await expect(successModal.getByRole('button', { name: 'Send Another' })).toBeVisible();
});

test('document detail share modal resets after done and send another', async ({ page }) => {
  await loginAsAlice(page);
  await mockDocumentEmailShare(page);

  await page.goto('/#/document/1');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sendModal = page.getByRole('dialog', { name: 'Send Note' });
  await expect(sendModal).toBeVisible();
  await sendModal.getByLabel('Recipient email').fill('classmate@example.com');
  await sendModal.getByLabel('Short message (optional)').fill('Please review this note before class.');
  await sendModal.getByLabel('Expiry days (optional)').fill('9');
  await sendModal.getByRole('button', { name: 'Send Email' }).click();

  const successModal = page.getByRole('dialog', { name: 'Note Sent' });
  await expect(successModal).toBeVisible();
  await successModal.getByRole('button', { name: 'Done' }).click();
  await expect(successModal).toHaveCount(0);

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const reopenedModal = page.getByRole('dialog', { name: 'Send Note' });
  await expect(reopenedModal).toBeVisible();
  await expect(reopenedModal.getByLabel('Recipient email')).toHaveValue('');
  await expect(reopenedModal.getByLabel('Short message (optional)')).toHaveValue('');
  await expect(reopenedModal.getByLabel('Expiry days (optional)')).toHaveValue('7');
  await reopenedModal.getByLabel('Recipient email').fill('classmate@example.com');
  await reopenedModal.getByLabel('Short message (optional)').fill('Second draft should reset too.');
  await reopenedModal.getByRole('button', { name: 'Send Email' }).click();

  await expect(page.getByRole('dialog', { name: 'Note Sent' })).toBeVisible();
  await successModal.getByRole('button', { name: 'Send Another' }).click();

  const resetModal = page.getByRole('dialog', { name: 'Send Note' });
  await expect(resetModal).toBeVisible();
  await expect(resetModal.getByLabel('Recipient email')).toHaveValue('');
  await expect(resetModal.getByLabel('Short message (optional)')).toHaveValue('');
  await expect(resetModal.getByLabel('Expiry days (optional)')).toHaveValue('7');
});

test('document detail more menu opens share links management first', async ({ page }) => {
  await loginAsAlice(page);

  await page.goto('/#/document/1');
  await expect(page.locator('.document-detail-card h1')).toHaveText('Graph Notes');
  await page.locator('.document-detail-more-trigger').click();
  await page.locator('.document-detail-more-popover').getByRole('button', { name: 'Manage Links' }).click();

  const manageModal = page.getByRole('dialog', { name: 'Manage Links' });
  await expect(manageModal).toBeVisible();
  await expect(manageModal.locator('.document-detail-share-links-panel')).toBeVisible();
  await expect(manageModal.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(manageModal.getByRole('button', { name: 'Revoke All' })).toBeVisible();
  await expect(manageModal.getByLabel('Recipient email')).toHaveCount(0);
});

test('document detail success mode disables copy link when email response omits share url', async ({ page }) => {
  await loginAsAlice(page);
  await mockDocumentEmailShare(page, 'classmate@example.com', { includeShareUrl: false });

  await page.goto('/#/document/1');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sendModal = page.getByRole('dialog', { name: 'Send Note' });
  await sendModal.getByLabel('Recipient email').fill('classmate@example.com');
  await sendModal.getByRole('button', { name: 'Send Email' }).click();

  const successModal = page.getByRole('dialog', { name: 'Note Sent' });
  await expect(successModal).toBeVisible();
  const copyLinkButton = successModal.getByRole('button', { name: 'Copy Link' });
  await expect(copyLinkButton).toBeDisabled();
  await expect(copyLinkButton).toHaveAttribute('title', /No share link was returned/);
  await expect(successModal).toContainText('Copy Link is unavailable');
});

test('document detail manage links modal handles long link lists', async ({ page }) => {
  await mockShareLinksList(page, 24);
  await loginAsAlice(page);

  await page.goto('/#/document/1');
  await page.locator('.document-detail-more-trigger').click();
  await page.locator('.document-detail-more-popover').getByRole('button', { name: 'Manage Links' }).click();

  const manageModal = page.getByRole('dialog', { name: 'Manage Links' });
  await expect(manageModal).toBeVisible();
  await expect(manageModal.locator('.notion-doc-share-list li')).toHaveCount(24);
  await expect(manageModal.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(manageModal.getByRole('button', { name: 'Done' })).toBeVisible();
  await expect(manageModal).toContainText('long-share-token-24');
});

test('document detail share modal closes with escape in send manage and success modes', async ({ page }) => {
  await loginAsAlice(page);
  await mockDocumentEmailShare(page);

  await page.goto('/#/document/1');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Send Note' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Send Note' })).toHaveCount(0);

  await page.locator('.document-detail-more-trigger').click();
  await page.locator('.document-detail-more-popover').getByRole('button', { name: 'Manage Links' }).click();
  await expect(page.getByRole('dialog', { name: 'Manage Links' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Manage Links' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sendModal = page.getByRole('dialog', { name: 'Send Note' });
  await sendModal.getByLabel('Recipient email').fill('classmate@example.com');
  await sendModal.getByRole('button', { name: 'Send Email' }).click();
  await expect(page.getByRole('dialog', { name: 'Note Sent' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Note Sent' })).toHaveCount(0);
});

test('public share link opens document view without sign in', async ({ page }) => {
  await page.goto(`/#/shared/${SEEDED_SHARE_TOKEN}`);

  await expect(page.getByText('Shared Document')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download Shared File' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In For Full Access' })).toBeVisible();
  await expect(page.locator('.document-detail-card h1')).toHaveText('Graph Notes');
  await expect(page.locator('.document-detail-card')).toContainText('graph traversal bfs dfs shortest path');

  const shareHeroBox = await page.locator('.document-share-hero').boundingBox();
  const detailCardBox = await page.locator('.document-detail-card').boundingBox();
  expect(shareHeroBox, 'share hero should have a bounding box').toBeTruthy();
  expect(detailCardBox, 'shared detail card should have a bounding box').toBeTruthy();
  expect(Math.abs(detailCardBox.x - shareHeroBox.x), 'shared detail card should align with share hero').toBeLessThanOrEqual(2);
  expect(Math.abs(detailCardBox.width - shareHeroBox.width), 'shared detail card should match share hero width').toBeLessThanOrEqual(2);
});
