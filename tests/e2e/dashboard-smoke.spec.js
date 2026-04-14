import { expect, test } from '@playwright/test';

async function loginAsAlice(page) {
  await page.goto('/#/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.locator('#login-username').fill('alice');
  await page.locator('#login-password').fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Notes', exact: true })).toBeVisible();
}

test('guest sign-in warning links to login', async ({ page }) => {
  await page.goto('/#/');

  const loginWarning = page.locator('#login-warning');
  await expect(loginWarning).toBeVisible();
  await expect(loginWarning).toContainText(
    'You are not signed in yet. Uploading, viewing, summarizing, deleting, and tag editing require sign-in.'
  );

  const signInText = loginWarning.locator('.notion-login-warning-signin');
  await expect(signInText).toHaveCSS('color', 'rgb(0, 0, 0)');
  await expect(signInText).toHaveCSS('font-weight', /700|bold/);

  await loginWarning.click();
  await expect(page).toHaveURL(/#\/login$/);
});

test('workspace invitation list refreshes while modal is open', async ({ page }) => {
  let inviteRefreshCount = 0;
  await page.route(/\/api\/workspaces\/ws-e2e\/invitations$/, async (route) => {
    inviteRefreshCount += 1;
    const requested = inviteRefreshCount > 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 902,
          email: 'znhy1234@gmail.com',
          token: 'polling-invite-token',
          status: requested ? 'requested' : 'pending',
          invite_url: 'http://localhost:5173/#/invite/polling-invite-token',
          expires_at: '2026-04-21T09:18:00.000Z',
          requested_username: requested ? 'znhy1234' : '',
          requested_at: requested ? '2026-04-14T10:26:00.000Z' : '',
        },
      ]),
    });
  });

  await loginAsAlice(page);
  await page.locator('.notion-workspace-trigger').click();
  await page.getByRole('button', { name: 'Invite Members' }).click();

  const inviteDialog = page.getByRole('dialog', { name: 'Invite Members' });
  await expect(inviteDialog.getByText('Awaiting request')).toBeVisible();
  await expect(inviteDialog.getByText('Pending approval')).toBeVisible({ timeout: 8000 });
  expect(inviteRefreshCount).toBeGreaterThanOrEqual(2);
});

test('messages center exposes friend code and add friend options', async ({ page }) => {
  await loginAsAlice(page);

  await page.getByRole('button', { name: /Messages/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Messages' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Your friend code')).toBeVisible();
  await expect(dialog.locator('.studyhub-friend-code-row strong')).toHaveText(/[A-Z0-9]{6,}/);

  await dialog.getByRole('button', { name: /Requests/ }).click();
  await expect(dialog.getByRole('button', { name: 'Email' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Login name' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add Friend' })).toBeVisible();
});

test('login, search documents, and open document detail pane', async ({ page }) => {
  await loginAsAlice(page);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();

  const searchInput = page.locator('#search-input');
  await expect(searchInput).toBeVisible();
  await searchInput.fill('graph');
  await searchInput.press('Enter');

  const graphCard = page.locator('.document-card', { hasText: 'Graph Notes' });
  await expect(graphCard).toBeVisible();
  await graphCard.getByRole('button', { name: 'Open' }).click();

  await expect(page.locator('.document-detail-card h2')).toHaveText('Graph Notes');
  await expect(page.locator('.document-detail-card')).toContainText('graph traversal bfs dfs');
});
