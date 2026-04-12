import { expect, test } from '@playwright/test';

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
}

test('private feedback flow supports user submission and admin public update', async ({ page }) => {
  await loginAsAlice(page);

  await page.getByRole('button', { name: 'Feedback' }).click();
  const feedbackModal = page.getByRole('dialog', { name: 'Help improve StudyHub' });
  await expect(feedbackModal).toBeVisible();
  await feedbackModal.getByLabel('Type').selectOption('ui_usability');
  await feedbackModal.getByLabel('Priority').selectOption('high');
  await feedbackModal.getByLabel('Title').fill('Playwright feedback smoke');
  await feedbackModal.getByLabel('Description').fill('Feedback modal should submit and appear in private history.');
  await feedbackModal.locator('form').getByRole('button', { name: 'Submit Feedback' }).click();

  await expect(feedbackModal.getByRole('tab', { name: 'My Feedback' })).toHaveAttribute('aria-selected', 'true');
  await expect(feedbackModal.getByText('Playwright feedback smoke')).toBeVisible();
  await feedbackModal.getByLabel('Close feedback').click();

  await page.goto('/#/admin/feedback');
  await expect(page.getByRole('heading', { name: 'Feedback Inbox' })).toBeVisible();
  await page.getByRole('row', { name: /Playwright feedback smoke/ }).click();
  await expect(page.locator('.studyhub-admin-feedback-detail-panel')).toContainText('Playwright feedback smoke');

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
  await reopenedModal.getByText('Playwright feedback smoke').click();
  await expect(reopenedModal).toContainText('Resolved');
  await expect(reopenedModal).toContainText('Resolved in the Playwright smoke test.');
});
