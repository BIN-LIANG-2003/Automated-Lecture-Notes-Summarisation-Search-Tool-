import { expect, test } from '@playwright/test';

const SEEDED_SHARE_TOKEN = 'graph-share-token';
const WORKSPACE_STATE_KEY = 'workspaceStateByAccount';
const MOBILE_VIEWPORTS = [
  { name: 'iphone-12', width: 390, height: 844 },
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'iphone-plus', width: 430, height: 932 },
];

async function expectNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      innerWidth: window.innerWidth,
      scrollWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0),
    };
  });
  expect(
    metrics.scrollWidth,
    `${label} overflowed horizontally: scrollWidth=${metrics.scrollWidth}, innerWidth=${metrics.innerWidth}`
  ).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

async function expectWithinViewport(page, locator, label) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${label} should have a bounding box`).toBeTruthy();
  expect(box.x, `${label} starts outside viewport`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} ends outside viewport`).toBeLessThanOrEqual((viewport?.width || 0) + 1);
}

async function loginAsAlice(page) {
  await page.goto('/#/login');
  const loginField = page.locator('#login-username');
  if (await loginField.isVisible().catch(() => false)) {
    await loginField.fill('alice');
    await page.locator('#login-password').fill('password123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Notes', exact: true })).toBeVisible();
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

    await loginAsAlice(page);
    await expect(page.locator('.notion-content')).toBeVisible();
    await expectNoHorizontalOverflow(page, `${viewport.name} home`);

    await goToMyFiles(page);
    await expectNoHorizontalOverflow(page, `${viewport.name} my files`);

    await openGraphNoteInFiles(page);
    await expectNoHorizontalOverflow(page, `${viewport.name} embedded reader`);

    await page.locator('.document-detail-card').getByRole('button', { name: 'Send', exact: true }).click();
    const sendModal = page.getByRole('dialog', { name: 'Send Note' });
    await expectWithinViewport(page, sendModal, `${viewport.name} send note modal`);
    await expectNoHorizontalOverflow(page, `${viewport.name} send note modal`);
    await sendModal.getByLabel('Close send note by email').click();

    await page.goto('/#/document/1');
    await expect(page.locator('.document-detail-card h1')).toHaveText('Graph Notes');
    await expectNoHorizontalOverflow(page, `${viewport.name} document detail`);

    await clearClientSession(page);
    await page.goto(`/#/shared/${SEEDED_SHARE_TOKEN}`);
    await expect(page.getByText('Shared Document')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download Shared File' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `${viewport.name} shared note`);
    await expectWithinViewport(page, page.locator('.document-detail-pre'), `${viewport.name} shared note text preview`);
    await expect(page.locator('.document-share-shell .document-detail-sidebar')).toHaveCount(0);
    await expect(page.locator('.document-share-shell .document-detail-layout-shared')).toBeVisible();

    await loginAsAlice(page);
    await page.goto('/#/admin/feedback');
    await expect(page.getByRole('heading', { name: 'Feedback Inbox' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `${viewport.name} admin feedback`);

    await page.goto('/#/invite/mobile-invalid-token');
    await expect(page.getByRole('heading', { name: 'Workspace Invitation' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `${viewport.name} invite`);
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
