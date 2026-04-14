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

test('workspace member can open settings and leave a shared workspace', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'Settings' })).toBeEnabled();
  await page.getByRole('button', { name: 'Settings' }).click();

  const settingsDialog = page.getByRole('dialog', { name: 'Workspace Settings' });
  await expect(settingsDialog.getByRole('button', { name: 'Leave Workspace' })).toBeVisible();
  await settingsDialog.getByRole('button', { name: 'Leave Workspace' }).click();

  const confirmDialog = page.getByRole('dialog', { name: 'Leave Workspace' });
  await confirmDialog.getByRole('button', { name: 'Leave Workspace' }).click();

  await expect(page.locator('.notion-top-title-group strong')).toHaveText("Bob's Workspace");
  await page.locator('.notion-workspace-trigger').click();
  await expect(page.getByRole('button', { name: /Alice's Workspace/ })).toHaveCount(0);
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
  let workspaceSettings = {
    allow_member_invites: false,
    restrict_invites_to_domains: false,
    allowed_email_domains: '',
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

  await loginAsAlice(page);
  await page.locator('.notion-workspace-trigger').click();
  await page.getByRole('button', { name: 'Settings' }).click();

  const settingsDialog = page.getByRole('dialog', { name: 'Workspace Settings' });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.getByRole('button', { name: 'Access' })).toHaveCount(0);
  await settingsDialog.getByLabel('Close workspace settings').click();

  await page.locator('.notion-workspace-trigger').click();
  await page.getByRole('button', { name: 'Invite Members' }).click();

  const inviteDialog = page.getByRole('dialog', { name: 'Invite Members' });
  await expect(inviteDialog.getByRole('heading', { name: 'Access Settings' })).toBeVisible();
  await inviteDialog.getByLabel('Trusted Domains').fill('school.edu');
  await inviteDialog.getByLabel('Invitation Link Expiry (days)').fill('12');
  await inviteDialog.getByLabel('Link Sharing').selectOption('public');
  await inviteDialog.getByLabel('Allow members to invite others').check();
  await inviteDialog.getByRole('button', { name: 'Save Access Settings' }).click();

  await expect.poll(() => savedSettings?.allowed_email_domains).toBe('school.edu');
  expect(savedSettings).toMatchObject({
    allow_member_invites: true,
    default_invite_expiry_days: 12,
    link_sharing_mode: 'public',
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
