import { expect, test } from '@playwright/test';

test('login, search documents, and open document detail pane', async ({ page }) => {
  await page.goto('/#/login');

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.locator('#login-username').fill('alice');
  await page.locator('#login-password').fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await page.waitForURL('**/#/');
  await expect(page.getByRole('button', { name: 'My Files' })).toBeVisible();
  await page.getByRole('button', { name: 'My Files' }).click();

  const searchInput = page.locator('#search-input');
  await expect(searchInput).toBeVisible();
  await searchInput.fill('graph');
  await page.locator('#search-btn').click();

  const graphCard = page.locator('.document-card', { hasText: 'Graph Notes' });
  await expect(graphCard).toBeVisible();
  await graphCard.getByRole('button', { name: 'View' }).click();

  await expect(page.locator('.document-detail-card h2')).toHaveText('Graph Notes');
  await expect(page.locator('.document-detail-card')).toContainText('graph traversal bfs dfs');
});
