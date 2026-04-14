import { expect, test } from '@playwright/test';

async function loginAs(page, username = 'alice') {
  await page.goto('/#/login');
  const loginField = page.locator('#login-username');
  if (await loginField.isVisible().catch(() => false)) {
    await loginField.fill(username);
    await page.locator('#login-password').fill('password123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Feedback' })).toBeVisible();
}

test('private feedback flow supports user submission and admin public update', async ({ page }, testInfo) => {
  const feedbackTitle = `Playwright feedback smoke ${Date.now()}-${testInfo.repeatEachIndex}-${testInfo.retry}`;
  await loginAs(page, 'alice');

  await page.getByRole('button', { name: 'Feedback' }).click();
  const feedbackModal = page.getByRole('dialog', { name: 'Help improve StudyHub' });
  await expect(feedbackModal).toBeVisible();
  await feedbackModal.getByLabel('Type').selectOption('ui_usability');
  await feedbackModal.getByLabel('Priority').selectOption('high');
  await feedbackModal.getByLabel('Title').fill('Upload OCR duplicate');
  await expect(feedbackModal.getByText('Upload OCR duplicate smoke')).toBeVisible();
  await feedbackModal.getByLabel('Title').fill(feedbackTitle);
  await feedbackModal.getByLabel('Description').fill('Feedback modal should submit and appear in private history.');
  await feedbackModal.locator('form').getByRole('button', { name: 'Submit Feedback' }).click();

  await expect(feedbackModal.getByRole('tab', { name: 'My Feedback' })).toHaveAttribute('aria-selected', 'true');
  await expect(feedbackModal.getByText(feedbackTitle)).toBeVisible();
  await feedbackModal.getByLabel('Close feedback').click();

  await page.goto('/#/admin/feedback');
  await expect(page.getByRole('heading', { name: 'Feedback Inbox' })).toBeVisible();
  const feedbackRow = page.getByRole('row').filter({ hasText: feedbackTitle });
  await expect(feedbackRow).toHaveCount(1);
  await feedbackRow.click();
  await expect(page.locator('.studyhub-admin-feedback-detail-panel')).toContainText(feedbackTitle);

  const controls = page.locator('.studyhub-admin-feedback-controls');
  await controls.getByLabel('Status').selectOption('resolved');
  await controls.getByRole('button', { name: 'Save Status' }).click();
  await expect(page.getByText('Feedback updated.')).toBeVisible();
  await controls.getByLabel('Public reply').fill('Resolved in the Playwright smoke test.');
  await controls.getByRole('button', { name: 'Add Public Reply' }).click();
  await expect(page.getByText('Public reply added')).toBeVisible();

  await page.goto('/#/');
  await page.getByRole('button', { name: 'Feedback' }).click();
  const reopenedModal = page.getByRole('dialog', { name: 'Help improve StudyHub' });
  await reopenedModal.getByRole('tab', { name: 'My Feedback' }).click();
  await reopenedModal.getByText(feedbackTitle).click();
  await expect(reopenedModal).toContainText('Resolved');
  await expect(reopenedModal).toContainText('Resolved in the Playwright smoke test.');
});

test('non-admin user sees a clean access denied state for admin feedback route', async ({ page }) => {
  await loginAs(page, 'bob');
  await page.goto('/#/admin/feedback');
  await page.waitForURL('**/#/admin/feedback');

  await expect(page.getByRole('heading', { name: 'Feedback Admin Access Required' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Feedback Inbox' })).toHaveCount(0);
});
