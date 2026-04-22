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

test('remember sign-in restores the account when opening a new browser tab link', async ({ page }) => {
  await page.goto('/#/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  const rememberCheckbox = page.locator('#login-remember-session');
  await expect(rememberCheckbox).toBeVisible();
  await rememberCheckbox.check();
  await page.locator('#login-username').fill('alice');
  await page.locator('#login-password').fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Notes', exact: true })).toBeVisible();

  const persistedSession = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('studyhub-auth-session') || '{}')
  );
  expect(persistedSession.username).toBe('alice');
  expect(persistedSession.authToken).toBeUndefined();
  expect(persistedSession.cookieBacked).toBe(true);
  expect(String(persistedSession.expiresAt || '')).not.toBe('');
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name === 'studyhub_auth' && cookie.httpOnly)).toBeTruthy();

  await page.evaluate(() => {
    window.sessionStorage.clear();
  });
  await page.goto('/#/');
  await expect(page.locator('#login-warning')).toHaveCount(0);
  await expect(page.locator('.notion-top-muted')).toContainText('Private workspace');
});

test('invite sign-in accepts the invitation and opens the workspace after login', async ({ page }) => {
  const token = 'return-to-invite-token';
  const invitedWorkspaceId = 'ws-invited';
  const requestedWorkspaceIds = [];
  await page.route(new RegExp(`/api/invitations/${token}(?:\\\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const viewerUsername = url.searchParams.get('username') || '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 903,
        workspace_id: invitedWorkspaceId,
        workspace_name: 'E2E Workspace',
        owner_username: 'teacher',
        email: 'alice@example.com',
        token,
        status: 'pending',
        expires_at: '2026-04-21T09:18:00.000Z',
        created_at: '2026-04-14T09:18:00.000Z',
        requested_username: '',
        requested_at: '',
        invite_url: `http://127.0.0.1:5001/#/invite/${token}`,
        requires_owner_confirmation: false,
        can_request: viewerUsername === 'alice',
        viewer_username: viewerUsername,
        viewer_email: viewerUsername ? 'alice@example.com' : '',
        viewer_is_active_member: false,
        can_open_workspace: false,
      }),
    });
  });
  await page.route(new RegExp(`/api/invitations/${token}/request-join$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 903,
        workspace_id: invitedWorkspaceId,
        workspace_name: 'E2E Workspace',
        owner_username: 'teacher',
        email: 'alice@example.com',
        token,
        status: 'approved',
        expires_at: '2026-04-21T09:18:00.000Z',
        created_at: '2026-04-14T09:18:00.000Z',
        requested_username: 'alice',
        requested_at: '2026-04-14T09:20:00.000Z',
        invite_url: `http://127.0.0.1:5001/#/invite/${token}`,
        requires_owner_confirmation: false,
        can_request: false,
        viewer_is_active_member: true,
        can_open_workspace: true,
      }),
    });
  });
  await page.route(/\/api\/workspaces\?username=alice$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: invitedWorkspaceId,
          name: 'E2E Workspace',
          plan: 'Free',
          owner_username: 'teacher',
          is_owner: false,
          members_count: 2,
          settings: {},
        },
      ]),
    });
  });
  await page.route(/\/api\/documents\?.*/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    requestedWorkspaceIds.push(url.searchParams.get('workspace_id') || '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
        facets: { tags: [], categories: [], file_types: {} },
      }),
    });
  });

  await page.goto(`/#/invite/${token}`);
  await expect(page.getByRole('heading', { name: 'Workspace Invitation' })).toBeVisible();

  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.locator('#login-username')).toHaveValue('alice@example.com');

  await page.locator('#login-username').fill('alice');
  await page.locator('#login-password').fill('password123');
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/auth/login') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect((await loginResponsePromise).ok()).toBeTruthy();

  await expect(page.locator('.notion-top-title-group strong')).toHaveText('E2E Workspace');
  await expect(page).toHaveURL(/#\/$/);
  await expect.poll(() => requestedWorkspaceIds).toContain(invitedWorkspaceId);
});

test('login defaults to the current user workspace before member workspaces', async ({ page }) => {
  const requestedWorkspaceIds = [];
  await page.route(/\/api\/workspaces\?username=bob$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'ws-e2e',
          name: "Alice's Workspace",
          plan: 'Free',
          owner_username: 'alice',
          is_owner: false,
          members_count: 2,
          settings: {},
        },
        {
          id: 'ws-bob-own',
          name: "Bob's Workspace",
          plan: 'Free',
          owner_username: 'bob',
          is_owner: true,
          members_count: 1,
          settings: {},
        },
      ]),
    });
  });
  await page.route(/\/api\/documents\?.*/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    requestedWorkspaceIds.push(url.searchParams.get('workspace_id') || '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
        facets: { tags: [], categories: [], file_types: {} },
      }),
    });
  });

  await page.goto('/#/login');
  await page.locator('#login-username').fill('bob');
  await page.locator('#login-password').fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.locator('.notion-top-title-group strong')).toHaveText("Bob's Workspace");
  await expect.poll(() => requestedWorkspaceIds).toContain('ws-bob-own');
});

test('workspace member removes a shared workspace from workspace manager', async ({ page }) => {
  let includeSharedWorkspace = true;
  const workspacePayload = () => [
    {
      id: 'ws-e2e',
      name: "Alice's Workspace",
      plan: 'Free',
      owner_username: 'alice',
      is_owner: false,
      members_count: 2,
      settings: {},
    },
    {
      id: 'ws-bob-own',
      name: "Bob's Workspace",
      plan: 'Free',
      owner_username: 'bob',
      is_owner: true,
      members_count: 1,
      settings: {},
    },
  ].filter((workspace) => includeSharedWorkspace || workspace.id !== 'ws-e2e');

  await page.route(/\/api\/workspaces\?username=bob$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(workspacePayload()),
    });
  });
  await page.route(/\/api\/workspaces\/ws-e2e\/members\/bob$/, async (route) => {
    expect(route.request().method()).toBe('DELETE');
    includeSharedWorkspace = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        removed_username: 'bob',
        workspace: {
          id: 'ws-e2e',
          name: "Alice's Workspace",
          plan: 'Free',
          owner_username: 'alice',
          is_owner: false,
          members_count: 1,
          settings: {},
        },
      }),
    });
  });
  await page.route(/\/api\/documents\?.*/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
        facets: { tags: [], categories: [], file_types: {} },
      }),
    });
  });

  await page.goto('/#/login');
  await page.locator('#login-username').fill('bob');
  await page.locator('#login-password').fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.locator('.notion-top-title-group strong')).toHaveText("Bob's Workspace");
  await page.locator('.notion-workspace-trigger').click();
  await page.getByRole('button', { name: /Alice's Workspace/ }).click();
  await expect(page.locator('.notion-top-title-group strong')).toHaveText("Alice's Workspace");

  await page.locator('.notion-workspace-trigger').click();
  await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Invite Members' }).click();
  const blockedInviteDialog = page.getByRole('dialog', { name: 'Invite Members' });
  await expect(blockedInviteDialog.getByRole('heading', { name: 'Invitations are disabled' })).toBeVisible();
  await expect(blockedInviteDialog.getByText('Please contact the workspace owner.')).toBeVisible();
  await expect(blockedInviteDialog.getByRole('button', { name: 'Send Invite Emails' })).toHaveCount(0);
  await blockedInviteDialog.getByLabel('Close invite members').click();

  await page.locator('.notion-workspace-trigger').click();
  await page.getByRole('button', { name: 'Manage workspaces' }).click();
  const managerDialog = page.getByRole('dialog', { name: 'Manage Workspaces' });
  await expect(managerDialog.getByRole('button', { name: 'Remove' })).toBeVisible();
  await managerDialog.getByRole('button', { name: 'Remove' }).click();

  const confirmDialog = page.getByRole('dialog', { name: 'Remove Workspace' });
  await confirmDialog.getByRole('button', { name: 'Remove Workspace' }).click();

  await expect(page.locator('.notion-top-title-group strong')).toHaveText("Bob's Workspace");
  await page.locator('.notion-workspace-trigger').click();
  await expect(page.getByRole('button', { name: /Alice's Workspace/ })).toHaveCount(0);
});

test('workspace manager can delete an owned workspace without switching away', async ({ page }) => {
  let includeArchiveWorkspace = true;
  let deleteRequestCount = 0;
  const workspacePayload = () => [
    {
      id: 'ws-bob-own',
      name: "Bob's Workspace",
      plan: 'Free',
      owner_username: 'bob',
      is_owner: true,
      members_count: 1,
      settings: {},
    },
    {
      id: 'ws-bob-archive',
      name: 'Archive Workspace',
      plan: 'Free',
      owner_username: 'bob',
      is_owner: true,
      members_count: 1,
      settings: {},
    },
  ].filter((workspace) => includeArchiveWorkspace || workspace.id !== 'ws-bob-archive');

  await page.route(/\/api\/workspaces\?username=bob$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(workspacePayload()),
    });
  });
  await page.route(/\/api\/workspaces\/ws-bob-archive$/, async (route) => {
    expect(route.request().method()).toBe('DELETE');
    deleteRequestCount += 1;
    includeArchiveWorkspace = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        deleted_workspace_id: 'ws-bob-archive',
        deleted_count: 0,
        warnings: [],
      }),
    });
  });
  await page.route(/\/api\/documents\?.*/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
        facets: { tags: [], categories: [], file_types: {} },
      }),
    });
  });

  await page.goto('/#/login');
  await page.locator('#login-username').fill('bob');
  await page.locator('#login-password').fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.locator('.notion-top-title-group strong')).toHaveText("Bob's Workspace");
  await page.locator('.notion-workspace-trigger').click();
  await page.getByRole('button', { name: 'Manage workspaces' }).click();

  const managerDialog = page.getByRole('dialog', { name: 'Manage Workspaces' });
  const archiveRow = managerDialog.locator('li').filter({ hasText: 'Archive Workspace' });
  await expect(archiveRow.getByRole('button', { name: 'Delete' })).toBeVisible();
  await archiveRow.getByRole('button', { name: 'Delete' }).click();

  const inputDialog = page.getByRole('dialog', { name: 'Delete Workspace' });
  await expect(inputDialog).toBeVisible();
  await inputDialog.getByRole('textbox').fill('Archive Workspace');
  await inputDialog.getByRole('button', { name: 'Delete Workspace' }).click();

  await expect(page.locator('.notion-top-title-group strong')).toHaveText("Bob's Workspace");
  await expect.poll(() => deleteRequestCount).toBe(1);
  await page.locator('.notion-workspace-trigger').click();
  await expect(page.getByRole('button', { name: /Archive Workspace/ })).toHaveCount(0);
  await expect(page.locator('.notion-space-switch').filter({ hasText: "Bob's Workspace" })).toBeVisible();
});

test('approved invite link opens the shared workspace after login', async ({ page }) => {
  const token = 'approved-invite-token';
  const requestedWorkspaceIds = [];
  await page.route(new RegExp(`/api/invitations/${token}(?:\\\\?.*)?$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 904,
        workspace_id: 'ws-e2e',
        workspace_name: "Alice's Workspace",
        owner_username: 'alice',
        email: 'bob@example.com',
        token,
        status: 'approved',
        expires_at: '2026-04-21T09:18:00.000Z',
        created_at: '2026-04-14T09:18:00.000Z',
        requested_username: 'bob',
        requested_at: '2026-04-14T09:20:00.000Z',
        invite_url: `http://127.0.0.1:5001/#/invite/${token}`,
        requires_owner_confirmation: false,
        can_request: false,
        viewer_is_active_member: true,
        can_open_workspace: true,
      }),
    });
  });
  await page.route(/\/api\/workspaces\?username=bob$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'ws-bob-own',
          name: "Bob's Workspace",
          plan: 'Free',
          owner_username: 'bob',
          is_owner: true,
          members_count: 1,
          settings: {},
        },
        {
          id: 'ws-e2e',
          name: "Alice's Workspace",
          plan: 'Free',
          owner_username: 'alice',
          is_owner: false,
          members_count: 2,
          settings: {},
        },
      ]),
    });
  });
  await page.route(/\/api\/documents\?.*/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    requestedWorkspaceIds.push(url.searchParams.get('workspace_id') || '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
        facets: { tags: [], categories: [], file_types: {} },
      }),
    });
  });

  await page.goto(`/#/invite/${token}`);
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.locator('#login-username')).toHaveValue('bob@example.com');
  await page.locator('#login-username').fill('bob');
  await page.locator('#login-password').fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.locator('.notion-top-title-group strong')).toHaveText("Alice's Workspace");
  await expect(page).toHaveURL(/#\/$/);
  await expect.poll(() => requestedWorkspaceIds).toContain('ws-e2e');
});

test('used invite link without active membership stays on the invitation page', async ({ page }) => {
  const token = 'used-invite-without-active-access';
  await page.route(new RegExp(`/api/invitations/${token}(?:\\\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const viewerUsername = url.searchParams.get('username') || '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 905,
        workspace_id: 'ws-e2e',
        workspace_name: "Alice's Workspace",
        owner_username: 'alice',
        email: 'bob@example.com',
        token,
        status: 'approved',
        expires_at: '2026-04-21T09:18:00.000Z',
        created_at: '2026-04-14T09:18:00.000Z',
        requested_username: 'bob',
        requested_at: '2026-04-14T09:20:00.000Z',
        invite_url: `http://127.0.0.1:5001/#/invite/${token}`,
        requires_owner_confirmation: false,
        can_request: false,
        viewer_username: viewerUsername,
        viewer_email: viewerUsername ? 'bob@example.com' : '',
        viewer_is_active_member: false,
        can_open_workspace: false,
        mismatch_reason: viewerUsername
          ? 'This invitation was already used and this account no longer has workspace access'
          : '',
      }),
    });
  });

  await page.goto(`/#/invite/${token}`);
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.locator('#login-username').fill('bob');
  await page.locator('#login-password').fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`#\\/invite\\/${token}$`));
  await expect(page.getByText('No active access')).toBeVisible();
  await expect(
    page.getByText('This invitation was already used and this account no longer has workspace access')
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Workspace' })).toHaveCount(0);
});

test('workspace invitation list refreshes while modal is open', async ({ page }) => {
  let inviteRefreshCount = 0;
  const workspacePayload = () => {
    const members = [
      {
        username: 'alice',
        email: 'alice@example.com',
        role: 'owner',
        status: 'active',
        created_at: '2026-04-14T09:00:00.000Z',
      },
    ];
    if (inviteRefreshCount > 1) {
      members.push({
        username: 'znhy1234',
        email: 'znhy1234@gmail.com',
        role: 'member',
        status: 'active',
        created_at: '2026-04-14T10:26:00.000Z',
      });
    }
    return {
      id: 'ws-e2e',
      name: "Alice's Workspace",
      plan: 'Free',
      owner_username: 'alice',
      is_owner: true,
      members_count: members.length,
      members,
      invites: [],
      pending_requests: [],
      settings: {},
    };
  };
  await page.route(/\/api\/workspaces\?username=alice$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([workspacePayload()]),
    });
  });
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
  await expect(inviteDialog.getByText('Ready to join')).toBeVisible();
  await expect(inviteDialog.getByText('Opened', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(inviteDialog.getByText('znhy1234@gmail.com', { exact: true })).toBeVisible();
  await expect(inviteDialog.getByText('2 active members')).toBeVisible();
  expect(inviteRefreshCount).toBeGreaterThanOrEqual(2);
});

test('workspace access settings are managed from invite members modal', async ({ page }) => {
  let savedSettings = null;
  let savedPreferences = null;
  let workspaceSettings = {
    allow_member_invites: false,
    restrict_invites_to_domains: false,
    allowed_email_domains: '',
    block_invites_from_domains: false,
    blocked_email_domains: '',
    default_invite_expiry_days: 7,
    link_sharing_mode: 'workspace',
    default_share_expiry_days: 7,
    max_active_share_links_per_document: 5,
    allow_member_share_management: false,
    auto_revoke_previous_share_links: false,
  };
  const workspacePayload = () => ({
    id: 'ws-e2e',
    name: "Alice's Workspace",
    plan: 'Free',
    owner_username: 'alice',
    is_owner: true,
    members_count: 1,
    members: [
      {
        username: 'alice',
        email: 'alice@example.com',
        role: 'owner',
        status: 'active',
        created_at: '2026-04-14T09:00:00.000Z',
      },
    ],
    invites: [],
    pending_requests: [],
    settings: workspaceSettings,
  });

  await page.route(/\/api\/workspaces\?username=alice$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([workspacePayload()]),
    });
  });
  await page.route(/\/api\/workspaces\/ws-e2e$/, async (route) => {
    expect(route.request().method()).toBe('PUT');
    const body = route.request().postDataJSON();
    savedSettings = body.settings;
    workspaceSettings = savedSettings;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(workspacePayload()),
    });
  });
  await page.route(/\/api\/workspaces\/ws-e2e\/invitations$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
  await page.route(/\/api\/auth\/me$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username: 'alice',
        email: 'alice@example.com',
        friend_code: 'ALICE123',
        preferences: {
          email_notifications_enabled: true,
        },
        authenticated: true,
      }),
    });
  });
  await page.route(/\/api\/auth\/preferences$/, async (route) => {
    const body = route.request().postDataJSON();
    savedPreferences = body;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username: 'alice',
        email: 'alice@example.com',
        preferences: {
          email_notifications_enabled: body.email_notifications_enabled,
        },
      }),
    });
  });

  await loginAsAlice(page);
  await page.locator('.notion-workspace-trigger').click();
  await page.getByRole('button', { name: 'Settings' }).click();

  const settingsDialog = page.getByRole('dialog', { name: 'Workspace Settings' });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.getByRole('button', { name: 'Access' })).toHaveCount(0);
  await settingsDialog.getByRole('button', { name: 'Notifications' }).click();
  await settingsDialog
    .getByLabel('Send email reminders for messages and workspace updates')
    .uncheck();
  await expect.poll(() => savedPreferences?.email_notifications_enabled).toBe(false);
  await settingsDialog.getByLabel('Close workspace settings').click();

  await page.locator('.notion-workspace-trigger').click();
  await page.getByRole('button', { name: 'Invite Members' }).click();

  const inviteDialog = page.getByRole('dialog', { name: 'Invite Members' });
  await expect(inviteDialog.getByRole('heading', { name: 'Invitation Settings' })).toBeVisible();
  await expect(inviteDialog.getByLabel('Link Sharing')).toHaveCount(0);
  await inviteDialog.getByLabel('Blocked Domains').fill('blocked.edu');
  await inviteDialog.getByLabel('Invitation Expiry (days)').fill('12');
  await inviteDialog.getByLabel('Allow members to invite others').check();
  await inviteDialog.getByLabel('Block specific email domains').check();
  await inviteDialog.getByRole('button', { name: 'Save Invitation Settings' }).click();

  await expect.poll(() => savedSettings?.blocked_email_domains).toBe('blocked.edu');
  expect(savedSettings).toMatchObject({
    allow_member_invites: true,
    block_invites_from_domains: true,
    default_invite_expiry_days: 12,
    link_sharing_mode: 'workspace',
  });
});

test('workspace owner can see and remove members from the invite modal', async ({ page }) => {
  let members = [
    {
      username: 'alice',
      email: 'alice@example.com',
      role: 'owner',
      status: 'active',
      created_at: '2026-04-14T09:00:00.000Z',
    },
    {
      username: 'bob',
      email: 'bob@example.com',
      role: 'member',
      status: 'active',
      created_at: '2026-04-14T09:20:00.000Z',
    },
  ];
  const workspacePayload = () => ({
    id: 'ws-e2e',
    name: "Alice's Workspace",
    plan: 'Free',
    owner_username: 'alice',
    is_owner: true,
    members_count: members.length,
    members,
    invites: [],
    pending_requests: [],
    settings: {},
  });

  await page.route(/\/api\/workspaces\?username=alice$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([workspacePayload()]),
    });
  });
  await page.route(/\/api\/workspaces\/ws-e2e\/invitations$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
  await page.route(/\/api\/workspaces\/ws-e2e\/members\/bob$/, async (route) => {
    expect(route.request().method()).toBe('DELETE');
    members = members.filter((member) => member.username !== 'bob');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        removed_username: 'bob',
        workspace: workspacePayload(),
      }),
    });
  });

  await loginAsAlice(page);
  await page.locator('.notion-workspace-trigger').click();
  await page.getByRole('button', { name: 'Invite Members' }).click();

  const inviteDialog = page.getByRole('dialog', { name: 'Invite Members' });
  await expect(inviteDialog.getByRole('heading', { name: 'Workspace Members' })).toBeVisible();
  await expect(inviteDialog.getByText('bob@example.com')).toBeVisible();
  await inviteDialog.getByRole('button', { name: 'Remove' }).click();

  const confirmDialog = page.getByRole('dialog', { name: 'Remove Member' });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Remove' }).click();

  await expect(inviteDialog.getByText('bob@example.com')).toHaveCount(0);
  await expect(inviteDialog.getByText('1 active member')).toBeVisible();
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

test('friend chat can send an uploaded file without email', async ({ page }) => {
  let shareRequest = null;
  const friendSummary = () => ({
    user: {
      username: 'alice',
      email: 'alice@example.com',
      friend_code: 'ALICE123',
    },
    friends: [
      {
        username: 'bob',
        email: 'bob@example.com',
        friend_code: 'BOB12345',
        unread_count: 0,
        last_message: null,
      },
    ],
    incoming_requests: [],
    outgoing_requests: [],
    messages: [],
    notifications: [],
    unread_count: 0,
  });

  await page.route(/\/api\/friends\/summary$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(friendSummary()),
    });
  });
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
            id: 41,
            filename: 'graph-notes.pdf',
            title: 'Graph Notes',
            uploaded_at: '2026-04-14T09:00:00.000Z',
            file_type: 'pdf',
            content: 'graph traversal',
            content_html: '',
            username: 'alice',
            tags: '',
            category: 'Computer Science',
            workspace_id: 'ws-e2e',
            processing_status: 'processed',
            processing_error: '',
            processed_at: '2026-04-14T09:00:00.000Z',
          },
        ],
        total: 1,
        limit: 100,
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
  await page.route(/\/api\/friends\/file-shares$/, async (route) => {
    shareRequest = await route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        message: 'File share sent to bob.',
        summary: friendSummary(),
      }),
    });
  });

  await loginAsAlice(page);
  await page.getByRole('button', { name: /Messages/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Messages' });
  await dialog.getByRole('button', { name: 'Share File' }).click();
  const sharePanel = dialog.locator('.studyhub-file-share-panel');
  await expect(sharePanel.getByLabel('File')).toHaveValue('41');
  await sharePanel.getByRole('textbox', { name: 'Note' }).fill('Please read this.');
  await sharePanel.getByRole('button', { name: 'Send File' }).click();

  await expect(dialog.getByText('File share sent to bob.')).toBeVisible();
  expect(shareRequest).toEqual({
    recipient_username: 'bob',
    document_id: '41',
    note: 'Please read this.',
  });
});

test('website file share request can be accepted into the files area', async ({ page }) => {
  let accepted = false;
  let respondRequest = null;
  const notificationSummary = () => ({
    user: {
      username: 'alice',
      email: 'alice@example.com',
      friend_code: 'ALICE123',
    },
    friends: [
      {
        username: 'liangbin',
        email: 'liangbin@example.com',
        friend_code: 'LB123456',
        unread_count: 0,
        last_message: null,
      },
    ],
    incoming_requests: [],
    outgoing_requests: [],
    messages: [],
    notifications: [
      {
        id: 811,
        type: 'friend_file_share',
        title: 'File shared with you',
        body: 'liangbin shared Shared Lab PDF with you. Accept it to add a copy to your files.',
        actor_username: 'liangbin',
        created_at: '2026-04-16T01:45:06.000Z',
        read_at: accepted ? '2026-04-16T01:46:00.000Z' : '',
        is_unread: !accepted,
        link_url: '',
        metadata: {
          status: accepted ? 'accepted' : 'pending',
          sender_username: 'liangbin',
          source_document_id: 77,
          document_title: 'Shared Lab PDF',
          document_file_type: 'pdf',
          accepted_document_id: accepted ? 91 : 0,
          accepted_workspace_id: accepted ? 'ws-e2e' : '',
        },
      },
    ],
    unread_count: accepted ? 0 : 1,
  });

  await page.route(/\/api\/friends\/summary$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(notificationSummary()),
    });
  });
  await page.route(/\/api\/friends\/file-shares\/811\/respond$/, async (route) => {
    respondRequest = await route.request().postDataJSON();
    accepted = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        message: 'File added to your files.',
        status: 'accepted',
        document_id: 91,
        workspace_id: 'ws-e2e',
        document: {
          id: 91,
          title: 'Shared Lab PDF',
          filename: 'shared-lab-copy.pdf',
          file_type: 'pdf',
          username: 'alice',
          workspace_id: 'ws-e2e',
        },
        summary: notificationSummary(),
      }),
    });
  });
  await page.route(/\/api\/documents\?.*/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: accepted
          ? [
            {
              id: 91,
              filename: 'shared-lab-copy.pdf',
              title: 'Shared Lab PDF',
              uploaded_at: '2026-04-16T01:46:00.000Z',
              file_type: 'pdf',
              content: 'shared lab body',
              content_html: '',
              username: 'alice',
              tags: '',
              category: 'Computer Science',
              workspace_id: 'ws-e2e',
              processing_status: 'processed',
              processing_error: '',
              processed_at: '2026-04-16T01:46:00.000Z',
            },
          ]
          : [],
        total: accepted ? 1 : 0,
        limit: 100,
        offset: 0,
        has_more: false,
        facets: {
          tags: [],
          categories: accepted ? ['Computer Science'] : [],
          file_types: accepted ? { pdf: 1 } : {},
        },
      }),
    });
  });

  await loginAsAlice(page);
  await page.getByRole('button', { name: /Messages/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Messages' });
  await dialog.getByRole('button', { name: /Website/ }).click();
  await expect(dialog.getByText('File shared with you')).toBeVisible();
  const saveWorkspace = dialog.getByLabel('Save to workspace');
  await expect(saveWorkspace).toBeVisible();
  await expect(saveWorkspace).toHaveValue('ws-e2e');
  await dialog.getByRole('button', { name: 'Accept' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.document-card', { hasText: 'Shared Lab PDF' })).toBeVisible();
  expect(respondRequest).toEqual({ action: 'accept', target_workspace_id: 'ws-e2e' });
});

test('website message Open switches to the related workspace access panel', async ({ page }) => {
  let notificationRead = false;
  const readRequests = [];
  const notificationSummary = () => ({
    user: {
      username: 'alice',
      email: 'alice@example.com',
      friend_code: 'ALICE123',
    },
    friends: [],
    incoming_requests: [],
    outgoing_requests: [],
    messages: [],
    notifications: [
      {
        id: 701,
        type: 'workspace',
        title: 'Workspace member joined',
        body: "bob joined Message Workspace using your invitation.",
        created_at: '2026-04-14T13:05:26.000Z',
        read_at: notificationRead ? '2026-04-14T13:06:00.000Z' : '',
        is_unread: !notificationRead,
        link_url: '/#/?workspace_id=ws-message',
        metadata: { workspace_id: 'ws-message' },
      },
    ],
    unread_count: notificationRead ? 0 : 1,
  });

  await page.route(/\/api\/friends\/summary$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(notificationSummary()),
    });
  });
  await page.route(/\/api\/friends\/read$/, async (route) => {
    readRequests.push(await route.request().postDataJSON());
    notificationRead = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ summary: notificationSummary() }),
    });
  });
  await page.route(/\/api\/workspaces\?username=alice$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'ws-alice-own',
          name: "Alice's Workspace",
          plan: 'Free',
          owner_username: 'alice',
          is_owner: true,
          members_count: 1,
          members: [
            {
              username: 'alice',
              email: 'alice@example.com',
              role: 'owner',
              status: 'active',
              created_at: '2026-04-14T09:00:00.000Z',
            },
          ],
          invites: [],
          pending_requests: [],
          settings: {},
        },
        {
          id: 'ws-message',
          name: 'Message Workspace',
          plan: 'Free',
          owner_username: 'alice',
          is_owner: true,
          members_count: 2,
          members: [
            {
              username: 'alice',
              email: 'alice@example.com',
              role: 'owner',
              status: 'active',
              created_at: '2026-04-14T09:00:00.000Z',
            },
            {
              username: 'bob',
              email: 'bob@example.com',
              role: 'member',
              status: 'active',
              created_at: '2026-04-14T13:05:26.000Z',
            },
          ],
          invites: [],
          pending_requests: [],
          settings: {},
        },
      ]),
    });
  });
  await page.route(/\/api\/workspaces\/ws-message\/invitations$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
  await page.route(/\/api\/documents\?.*/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
        facets: { tags: [], categories: [], file_types: {} },
      }),
    });
  });

  await loginAsAlice(page);
  await page.getByRole('button', { name: /Messages/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Messages' });
  await dialog.getByRole('button', { name: /Website/ }).click();
  await expect(dialog.getByText('Workspace member joined')).toBeVisible();

  await dialog.getByRole('button', { name: 'Open' }).click();

  await expect(page.locator('.notion-top-title-group strong')).toHaveText('Message Workspace');
  await expect(page.getByRole('dialog', { name: 'Invite Members' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Invite Members' }).getByText('bob@example.com')).toBeVisible();
  await expect.poll(() => readRequests.length).toBe(1);
  expect(readRequests[0]).toEqual({ notification_ids: [701] });
});

test('shared note website message returns to the messages panel', async ({ page }) => {
  const shareToken = 'message-share-token';
  let notificationRead = false;
  const notificationSummary = () => ({
    user: {
      username: 'alice',
      email: 'alice@example.com',
      friend_code: 'ALICE123',
    },
    friends: [],
    incoming_requests: [],
    outgoing_requests: [],
    messages: [],
    notifications: [
      {
        id: 801,
        type: 'share',
        title: 'Shared note from a friend',
        body: 'liangbin shared Message Shared PDF with you.',
        created_at: '2026-04-16T01:45:06.000Z',
        read_at: notificationRead ? '2026-04-16T01:46:00.000Z' : '',
        is_unread: !notificationRead,
        link_url: `/#/shared/${shareToken}`,
        metadata: { share_token: shareToken },
      },
    ],
    unread_count: notificationRead ? 0 : 1,
  });

  await page.route(/\/api\/friends\/summary$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(notificationSummary()),
    });
  });
  await page.route(/\/api\/friends\/read$/, async (route) => {
    notificationRead = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ summary: notificationSummary() }),
    });
  });
  await page.route(new RegExp(`/api/share-links/${shareToken}(?:\\\\?.*)?$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 88,
        filename: 'message-shared.pdf',
        title: 'Message Shared PDF',
        uploaded_at: '2026-04-13T22:38:31.000Z',
        file_type: 'pdf',
        content: 'message shared body',
        content_html: '<p>message shared body</p>',
        username: 'liangbin',
        tags: '',
        category: 'Computer Science',
        workspace_id: 'ws-friend',
        link_sharing_mode: 'workspace',
        can_manage_share_links: false,
        allow_ai_tools: true,
        allow_ocr: true,
        allow_export: true,
        share: {
          token: shareToken,
          status: 'active',
          expires_at: '2026-04-23T01:44:44.000Z',
          created_at: '2026-04-16T01:44:44.000Z',
          last_access_at: '2026-04-16T02:33:21.000Z',
          is_expired: false,
          is_accessible: true,
        },
      }),
    });
  });

  await loginAsAlice(page);
  await page.getByRole('button', { name: /Messages/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Messages' });
  await dialog.getByRole('button', { name: /Website/ }).click();
  await dialog.getByRole('button', { name: 'Open' }).click();

  await expect(page).toHaveURL(new RegExp(`#/shared/${shareToken}`));
  await expect(page.locator('.document-detail-card h1')).toHaveText('Message Shared PDF');

  await page.getByRole('button', { name: '← Back to Messages' }).click();

  const returnedDialog = page.getByRole('dialog', { name: 'Messages' });
  await expect(returnedDialog).toBeVisible();
  await expect(returnedDialog.getByRole('button', { name: /Website/ })).toHaveClass(/is-active/);
  await expect(returnedDialog.getByText('Shared note from a friend')).toBeVisible();
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

test('document cards can be renamed from the more menu', async ({ page }) => {
  await page.route(/\/api\/documents\/1\/title$/, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 1,
        filename: 'graph-notes.txt',
        title: 'Renamed Graph Notes.pdf',
        uploaded_at: '2026-04-03T12:00:00.000Z',
        file_type: 'txt',
        content: 'graph traversal bfs dfs shortest path smoke test content',
        content_html: '<p>graph traversal bfs dfs shortest path smoke test content</p>',
        username: 'alice',
        tags: 'graphs,smoke',
        category: 'Computer Science',
        workspace_id: 'ws-e2e',
        processing_status: 'processed',
        processing_error: '',
        processed_at: '2026-04-03T12:00:00.000Z',
      }),
    });
  });
  await loginAsAlice(page);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();

  const graphCard = page.locator('.document-card', { hasText: 'Graph Notes' });
  await expect(graphCard).toBeVisible();
  await graphCard.getByRole('button', { name: /More actions for Graph Notes/ }).click();
  await graphCard.getByRole('menuitem', { name: 'Rename' }).click();

  const renameDialog = page.locator('.notion-input-modal');
  await expect(renameDialog.getByRole('heading', { name: 'Rename Note' })).toBeVisible();
  await renameDialog.getByRole('textbox').fill('Renamed Graph Notes.pdf');
  await renameDialog.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('.document-card', { hasText: 'Renamed Graph Notes.pdf' })).toBeVisible();
});
