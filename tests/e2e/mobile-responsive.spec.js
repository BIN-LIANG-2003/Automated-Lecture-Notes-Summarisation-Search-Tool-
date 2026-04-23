import { expect, test } from '@playwright/test';

const SEEDED_SHARE_TOKEN = 'graph-share-token';
const WORKSPACE_STATE_KEY = 'workspaceStateByAccount';
const MOBILE_DOCX_DOC = {
  id: 2,
  filename: 'Automated_Lecture_Notes_Draft.docx',
  title: 'Automated_Lecture_Notes_Draft.docx',
  uploaded_at: '2026-04-19T22:52:07',
  uploadedAt: '2026-04-19T22:52:07',
  file_type: 'docx',
  fileType: 'docx',
  content:
    'Automated Lecture Notes Summarisation and Sharing Final Report Draft Abstract with long mobile text.',
  content_html: `
    <div style="width: 980px">
      <h1 style="text-align: center; font-size: 42px">Automated Lecture Notes Summarisation and Sharing</h1>
      <h2 style="text-align: center; font-size: 34px">Final Report Draft</h2>
      <p style="width: 900px; text-align: center; font-size: 20px">
        Submitted for the Honours Stage Project module with a very long centered line that must wrap on mobile screens.
      </p>
      <h2 style="font-size: 36px">Abstract</h2>
      <p style="width: 880px; font-size: 18px">
        This project developed a web-based system where university students upload, organise, share, and summarise lecture notes.
      </p>
    </div>
  `,
  contentHtml: '',
  tags: '',
  category: 'Business',
  username: 'alice',
  workspace_id: 'ws-e2e',
  workspaceId: 'ws-e2e',
  processing_status: '',
  processingStatus: '',
  processing_error: '',
  processingError: '',
};
const MOBILE_VIEWPORTS = [
  { name: 'iphone-12', width: 390, height: 844 },
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'iphone-plus', width: 430, height: 932 },
];

async function expectNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const viewportWidth = root.clientWidth || window.innerWidth;
    return {
      innerWidth: window.innerWidth,
      clientWidth: viewportWidth,
      scrollWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0),
    };
  });
  expect(
    metrics.scrollWidth,
    `${label} overflowed horizontally: scrollWidth=${metrics.scrollWidth}, clientWidth=${metrics.clientWidth}, innerWidth=${metrics.innerWidth}`
  ).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function expectCompactMobileChrome(page, label) {
  const metrics = await page.evaluate(() => {
    const rectHeight = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? Math.round(rect.height) : 0;
    };
    return {
      topbarHeight: rectHeight('.notion-topbar'),
      filesActionbarHeight: rectHeight('.notion-files-actionbar'),
      resultsHeadHeight: rectHeight('.notion-files-results-head'),
    };
  });
  expect(metrics.topbarHeight, `${label} topbar should stay compact`).toBeLessThanOrEqual(150);
  if (metrics.filesActionbarHeight) {
    expect(metrics.filesActionbarHeight, `${label} files actionbar should stay compact`).toBeLessThanOrEqual(90);
  }
  if (metrics.resultsHeadHeight) {
    expect(metrics.resultsHeadHeight, `${label} results header should stay compact`).toBeLessThanOrEqual(180);
  }
}

async function expectWithinViewport(page, locator, label) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${label} should have a bounding box`).toBeTruthy();
  expect(box.x, `${label} starts outside viewport`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} ends outside viewport`).toBeLessThanOrEqual((viewport?.width || 0) + 1);
}

async function expectVisibleInteractiveControlsInsideViewport(page, label) {
  const offenders = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    const selector = [
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[role="combobox"]',
    ].join(',');
    return Array.from(document.querySelectorAll(selector))
      .filter((element) => {
        if (element.closest('.skip-link')) return false;
        if (element.closest('.notion-sidebar') && !element.closest('.notion-sidebar.is-open')) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        if (rect.bottom < 0 || rect.top > viewportHeight) return false;
        return rect.left < -1 || rect.right > viewportWidth + 1;
      })
      .slice(0, 8)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: String(element.className || ''),
          text: String(element.textContent || element.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      });
  });
  expect(offenders, `${label} has visible controls outside the mobile viewport`).toEqual([]);
}

async function loginAsAlice(page) {
  await page.goto('/#/login');
  const loginField = page.locator('#login-username');
  const notesButton = page.getByRole('button', { name: 'Notes', exact: true });
  await Promise.race([
    loginField.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => null),
    notesButton.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => null),
  ]);
  if (await loginField.isVisible().catch(() => false)) {
    await loginField.fill('alice');
    await page.locator('#login-password').fill('password123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(notesButton).toBeVisible();
}

async function goToMyFiles(page) {
  const mobileNavButton = page.getByRole('button', { name: 'Open navigation' });
  if (await mobileNavButton.isVisible().catch(() => false)) {
    await mobileNavButton.click();
    await expect(page.locator('.notion-sidebar')).toHaveClass(/is-open/);
    await page.locator('.notion-sidebar').getByRole('button', { name: 'Notes', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
  }
  await expect(page.locator('#files-section')).toBeVisible();
  await expect(page.locator('#search-input')).toBeVisible();
}

async function openGraphNoteInFiles(page) {
  await goToMyFiles(page);
  const searchInput = page.locator('#search-input');
  await searchInput.fill('graph');
  await searchInput.press('Enter');
  const graphCard = page.locator('.document-card', { hasText: 'Graph Notes' });
  await expect(graphCard).toBeVisible();
  await graphCard.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('.document-detail-card').getByRole('heading', { name: 'Graph Notes' })).toBeVisible();
}

async function mockDocxDocumentList(page) {
  await page.route(/\/api\/documents\?.*/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [MOBILE_DOCX_DOC],
        total: 1,
        limit: 20,
        offset: 0,
        has_more: false,
        facets: { tags: [], categories: ['Business'], file_types: { docx: 1 } },
      }),
    });
  });
  await page.route(/\/api\/documents\/2(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOBILE_DOCX_DOC),
    });
  });
}

async function clearClientSession(page) {
  await page.evaluate(() => {
    window.sessionStorage.clear();
    window.localStorage.removeItem('authToken');
    window.localStorage.removeItem('studyhub-auth-session');
  });
}

for (const viewport of MOBILE_VIEWPORTS) {
  test(`major routes stay usable without horizontal overflow on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto('/#/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `${viewport.name} login`);
    await expectWithinViewport(page, page.locator('.login-card'), `${viewport.name} login card`);
    await expectVisibleInteractiveControlsInsideViewport(page, `${viewport.name} login`);

    await loginAsAlice(page);
    await expect(page.locator('.notion-content')).toBeVisible();
    await expectCompactMobileChrome(page, `${viewport.name} home`);
    await expectNoHorizontalOverflow(page, `${viewport.name} home`);
    await expectVisibleInteractiveControlsInsideViewport(page, `${viewport.name} home`);

    await goToMyFiles(page);
    await expectCompactMobileChrome(page, `${viewport.name} my files`);
    await expectNoHorizontalOverflow(page, `${viewport.name} my files`);
    await expectVisibleInteractiveControlsInsideViewport(page, `${viewport.name} my files`);

    await openGraphNoteInFiles(page);
    await expectNoHorizontalOverflow(page, `${viewport.name} embedded reader`);
    await expectVisibleInteractiveControlsInsideViewport(page, `${viewport.name} embedded reader`);

    await page.locator('.document-detail-card').getByRole('button', { name: 'Send', exact: true }).click();
    const sendModal = page.getByRole('dialog', { name: 'Send Note' });
    await expectWithinViewport(page, sendModal, `${viewport.name} send note modal`);
    await expectNoHorizontalOverflow(page, `${viewport.name} send note modal`);
    await expectVisibleInteractiveControlsInsideViewport(page, `${viewport.name} send note modal`);
    await sendModal.getByLabel('Close send note by email').click();

    await page.goto('/#/document/1');
    await expect(page.locator('.document-detail-card h1')).toHaveText('Graph Notes');
    await expectNoHorizontalOverflow(page, `${viewport.name} document detail`);
    await expectVisibleInteractiveControlsInsideViewport(page, `${viewport.name} document detail`);

    await clearClientSession(page);
    await page.goto(`/#/shared/${SEEDED_SHARE_TOKEN}`);
    await expect(page.getByText('Shared Document')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download Shared File' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `${viewport.name} shared note`);
    await expectVisibleInteractiveControlsInsideViewport(page, `${viewport.name} shared note`);
    await expectWithinViewport(page, page.locator('.document-detail-pre'), `${viewport.name} shared note text preview`);
    await expect(page.locator('.document-share-shell .document-detail-sidebar')).toHaveCount(0);
    await expect(page.locator('.document-share-shell .document-detail-layout-shared')).toBeVisible();

    await loginAsAlice(page);
    await page.goto('/#/admin/feedback');
    await expect(page.getByRole('heading', { name: 'Feedback Inbox' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `${viewport.name} admin feedback`);
    await expectVisibleInteractiveControlsInsideViewport(page, `${viewport.name} admin feedback`);

    await page.goto('/#/invite/mobile-invalid-token');
    await expect(page.getByRole('heading', { name: 'Workspace Invitation' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `${viewport.name} invite`);
    await expectVisibleInteractiveControlsInsideViewport(page, `${viewport.name} invite`);
  });
}

test('home ignores stale locally stored workspace before loading documents on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(
    ({ workspaceKey }) => {
      window.localStorage.setItem(
        workspaceKey,
        JSON.stringify({
          alice: {
            activeWorkspaceId: 'ws-stale-mobile',
            workspaces: [
              {
                id: 'ws-stale-mobile',
                name: 'Old Local Workspace',
                plan: 'Free',
                members: ['alice'],
              },
            ],
          },
        })
      );
    },
    { workspaceKey: WORKSPACE_STATE_KEY }
  );

  const documentResponses = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/documents?')) {
      documentResponses.push({ url, status: response.status() });
    }
  });

  await loginAsAlice(page);
  await goToMyFiles(page);
  await expect.poll(() => documentResponses.some(
    (item) => item.status === 200 && item.url.includes('workspace_id=ws-e2e')
  )).toBeTruthy();
  expect(
    documentResponses.some((item) => item.url.includes('workspace_id=ws-stale-mobile')),
    'documents should not be requested with a stale local workspace id'
  ).toBe(false);
  expect(
    documentResponses.some((item) => item.status === 403),
    'stale workspace should not produce an avoidable document-list 403'
  ).toBe(false);
  await expectNoHorizontalOverflow(page, 'stale workspace mobile home');
});

test('docx file reader stays inside the mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDocxDocumentList(page);
  await loginAsAlice(page);
  await goToMyFiles(page);

  const docxCard = page.locator('.document-card', { hasText: MOBILE_DOCX_DOC.title });
  await expect(docxCard).toBeVisible();
  await docxCard.getByRole('button', { name: 'Open' }).click();

  const reader = page.locator('.notion-inline-doc-card');
  await expect(reader.getByRole('heading', { name: MOBILE_DOCX_DOC.title })).toBeVisible();
  await expectNoHorizontalOverflow(page, 'mobile docx reader');
  await expectWithinViewport(page, reader, 'mobile docx reader card');
  await expectWithinViewport(page, page.locator('.notion-doc-rich-view'), 'mobile docx rich preview');

  const layout = await page.evaluate(() => {
    const metaLeftEdges = Array.from(document.querySelectorAll('.notion-inline-doc-meta-item'))
      .map((element) => Math.round(element.getBoundingClientRect().left));
    const actionWidths = Array.from(document.querySelectorAll('.notion-inline-doc-actions button'))
      .map((element) => Math.round(element.getBoundingClientRect().width));
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    return {
      metaColumnCount: new Set(metaLeftEdges).size,
      minActionWidth: Math.min(...actionWidths),
      viewportWidth,
    };
  });
  expect(layout.metaColumnCount).toBe(1);
  expect(layout.minActionWidth).toBeGreaterThan(layout.viewportWidth - 80);
});
