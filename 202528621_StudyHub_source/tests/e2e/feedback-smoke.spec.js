import { expect, test } from '@playwright/test';

async function loginAs(page, username = 'alice') {
  await page.goto('/#/login');
  const loginField = page.locator('#login-username');
  const appShell = page.locator('.notion-shell');
  await Promise.race([
    loginField.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => null),
    appShell.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => null),
  ]);
  if (await loginField.isVisible().catch(() => false)) {
    await loginField.fill(username);
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
  await expect(appShell).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#main')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Feedback' })).toBeVisible({ timeout: 15_000 });
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

  const submittedToast = page.getByText('Feedback submitted successfully.');
  await expect(submittedToast).toBeVisible();
  await expect(feedbackModal).toHaveCount(0);
  await expect(submittedToast).toHaveCount(0, { timeout: 2500 });

  await page.goto('/#/admin/feedback');
  await expect(page.getByRole('heading', { name: 'Feedback Inbox' })).toBeVisible();
  await expect(page.locator('.studyhub-admin-feedback-list-panel')).toBeVisible();
  await expect(page.locator('.studyhub-admin-feedback-detail-panel')).toHaveCount(0);
  const feedbackRow = page.getByRole('row').filter({ hasText: feedbackTitle });
  await expect(feedbackRow).toHaveCount(1);
  await feedbackRow.click();
  const detailPanel = page.locator('.studyhub-admin-feedback-detail-panel');
  await expect(page.locator('.studyhub-admin-feedback-list-panel')).toHaveCount(0);
  await expect(detailPanel).toContainText(feedbackTitle);
  await expect(detailPanel.getByRole('button', { name: 'Back to inbox' })).toBeVisible();

  const controls = page.locator('.studyhub-admin-feedback-controls');
  await controls.getByLabel('Status').selectOption('resolved');
  await controls.getByRole('button', { name: 'Save Status' }).click();
  await expect(page.getByText('Feedback updated.')).toBeVisible();
  await controls.getByLabel('Reply to user').fill('Resolved in the Playwright smoke test.');
  await controls.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByText('Public reply added')).toBeVisible();

  await page.goto('/#/');
  await page.getByRole('button', { name: 'Feedback' }).click();
  const reopenedModal = page.getByRole('dialog', { name: 'Help improve StudyHub' });
  await reopenedModal.getByRole('tab', { name: 'My Feedback' }).click();
  await reopenedModal.getByText(feedbackTitle).click();
  await expect(reopenedModal).toContainText('Resolved');
  await expect(reopenedModal).toContainText('Resolved in the Playwright smoke test.');
  await reopenedModal.getByLabel('Continue this feedback').fill('I can confirm the admin reply and close this now.');
  await reopenedModal.getByRole('button', { name: 'Send follow-up' }).click();
  await expect(reopenedModal).toContainText('Your follow-up');
  await expect(reopenedModal).toContainText('I can confirm the admin reply and close this now.');
  await reopenedModal.getByRole('button', { name: 'End feedback' }).click();
  await expect(reopenedModal).toContainText('Feedback closed');
  await expect(reopenedModal).toContainText('The project owner will see this feedback as completed.');

  await page.goto('/#/admin/feedback');
  await expect(page.getByRole('heading', { name: 'Feedback Inbox' })).toBeVisible();
  const closedFeedbackRow = page.getByRole('row').filter({ hasText: feedbackTitle });
  await expect(closedFeedbackRow).toHaveCount(1);
  await closedFeedbackRow.click();
  await expect(page.locator('.studyhub-admin-feedback-detail-panel')).toContainText('Closed');
  await expect(page.locator('.studyhub-admin-feedback-detail-panel')).toContainText('User follow-up');
});

test('non-admin user sees a clean access denied state for admin feedback route', async ({ page }) => {
  await loginAs(page, 'bob');
  await page.goto('/#/admin/feedback');
  await page.waitForURL('**/#/admin/feedback');

  await expect(page.getByRole('heading', { name: 'Feedback Admin Access Required' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Feedback Inbox' })).toHaveCount(0);
});
