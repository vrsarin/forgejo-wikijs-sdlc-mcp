import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { registerConnectionTools, resolveCallerCredential, subjectOf, toolResult as result, type McpRequestContext as Context } from '../../core/connection-tools.js'
import type { ProviderOAuth } from './provider-oauth.js'
import { FORGEJO_TOKEN_HEADER, type ForgejoClient, type ForgejoRecord } from './forgejo.js'

const repoRef = { owner: z.string().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/), repo: z.string().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/) }
const index = z.number().int().positive()
const page = z.number().int().positive().default(1)
const limit = z.number().int().min(1).max(100).default(50)
const mutation = { confirmed: z.literal(true).describe('The user explicitly authorized this exact mutation.'), reason: z.string().min(3).max(500) }
const idempotencyKey = z.string().min(3).max(128).regex(/^[A-Za-z0-9_.:-]+$/)
type Shape = Record<string, z.ZodType>
type Handler<S extends Shape> = (input: z.infer<z.ZodObject<S>>) => Promise<ReturnType<typeof result>>

/**
 * With `requireUserToken`, every tool call must act as the calling user: through the Forgejo grant they
 * approved once (`connect_forgejo`), or an explicit token in the X-Forgejo-Token header. Forgejo then
 * applies that user's permissions and records them as the actor.
 */
export function createForgejoServer(forgejo: ForgejoClient, writesEnabled = false, requireUserToken = false, oauth?: ProviderOAuth): McpServer {
  const server = new McpServer({ name: 'forgejo_workflow', version: '0.3.0' })
  const asCaller = <S extends Shape>(handler: Handler<S>) => async (input: z.infer<z.ZodObject<S>>, context: Context) => {
    const token = await resolveCallerCredential(context, {
      id: 'forgejo', label: 'Forgejo', header: FORGEJO_TOKEN_HEADER, required: requireUserToken,
      offerMessage: 'Connect your Forgejo account so this server can act as you. Check the account shown on the Forgejo page and approve.',
      approvalHint: 'Open the link in the browser where you are signed in to Forgejo as yourself, check the account shown, approve, then repeat your request',
      ...(oauth ? { oauth } : {})
    })
    if (token) return forgejo.runAs(token, () => handler(input))
    return handler(input)
  }
  const read = <S extends Shape>(name: string, description: string, inputSchema: S, handler: Handler<S>) => server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } }, asCaller(handler) as never)
  const write = <S extends Shape>(name: string, description: string, inputSchema: S, handler: Handler<S & typeof mutation>, idempotent = true) => {
    if (writesEnabled) server.registerTool(name, { description, inputSchema: { ...inputSchema, ...mutation }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: true } }, asCaller(handler) as never)
  }

  read('get_repository', 'Read repository metadata, permissions, default branch, and enabled units.', repoRef, async ({ owner, repo }) => result(await forgejo.getRepository(owner, repo)))
  read('search_issues', 'Search issues and pull requests in one allowed repository.', { ...repoRef, query: z.string().max(255).optional(), state: z.enum(['open', 'closed', 'all']).default('open'), type: z.enum(['issues', 'pulls']).optional(), labels: z.string().max(500).optional(), page, limit }, async ({ owner, repo, query: q, state, type, labels, page, limit }) => result(await forgejo.searchIssues(owner, repo, { q, state, type, labels, page, limit })))
  read('get_issue', 'Read one existing Forgejo issue or pull request work item.', { ...repoRef, index }, async ({ owner, repo, index }) => result(await forgejo.getIssue(owner, repo, index)))
  write('create_issue', 'Create an idempotent issue and read it back.', { ...repoRef, title: z.string().min(1).max(255), body: z.string().max(1_000_000).optional(), assignees: z.array(z.string().min(1).max(255)).max(20).optional(), labels: z.array(z.number().int().positive()).max(50).optional(), milestone: z.number().int().positive().optional(), dueDate: z.string().datetime().optional(), idempotencyKey }, async ({ owner, repo, title, body, assignees, labels, milestone, dueDate, idempotencyKey, reason }) => result({ outcome: 'verified', reason, ...(await forgejo.createIssue(owner, repo, { title, idempotencyKey, ...(body !== undefined ? { body } : {}), ...(assignees !== undefined ? { assignees } : {}), ...(labels !== undefined ? { labels } : {}), ...(milestone !== undefined ? { milestone } : {}), ...(dueDate !== undefined ? { due_date: dueDate } : {}) })) }))
  write('update_issue', 'Update issue content, state, assignees, milestone, or deadline and read it back.', { ...repoRef, index, title: z.string().min(1).max(255).optional(), body: z.string().max(1_000_000).optional(), state: z.enum(['open', 'closed']).optional(), assignees: z.array(z.string().min(1).max(255)).max(20).optional(), milestone: z.number().int().nonnegative().optional(), dueDate: z.string().datetime().optional(), unsetDueDate: z.boolean().optional() }, async ({ owner, repo, index, dueDate, unsetDueDate, reason, confirmed: _confirmed, ...fields }) => { const patch: ForgejoRecord = { ...fields, ...(dueDate ? { due_date: dueDate } : {}), ...(unsetDueDate === undefined ? {} : { unset_due_date: unsetDueDate }) }; delete patch.owner; delete patch.repo; if (Object.keys(patch).length === 0) throw new Error('At least one issue field must change.'); return result({ outcome: 'verified', reason, issue: await forgejo.updateIssue(owner, repo, index, patch) }) })
  read('list_issue_comments', 'List issue or pull-request conversation comments.', { ...repoRef, index, page, limit }, async ({ owner, repo, index, page, limit }) => result(await forgejo.listIssueComments(owner, repo, index, page, limit)))
  write('add_issue_comment', 'Add an idempotent trace note, decision, or evidence comment and read it back.', { ...repoRef, index, body: z.string().min(1).max(1_000_000), idempotencyKey }, async ({ owner, repo, index, body, idempotencyKey, reason }) => result({ outcome: 'verified', reason, ...(await forgejo.addIssueComment(owner, repo, index, body, idempotencyKey)) }))
  read('list_issue_dependencies', 'List work that an issue depends on.', { ...repoRef, index }, async ({ owner, repo, index }) => result(await forgejo.listDependencies(owner, repo, index)))
  write('add_issue_dependency', 'Add and verify an allowed-repository issue dependency.', { ...repoRef, index, dependencyOwner: repoRef.owner, dependencyRepo: repoRef.repo, dependencyIndex: index }, async ({ owner, repo, index, dependencyOwner, dependencyRepo, dependencyIndex, reason }) => result({ outcome: 'verified', reason, dependencies: await forgejo.addDependency(owner, repo, index, { owner: dependencyOwner, repo: dependencyRepo, index: dependencyIndex }) }))
  write('remove_issue_dependency', 'Remove and verify an issue dependency.', { ...repoRef, index, dependencyOwner: repoRef.owner, dependencyRepo: repoRef.repo, dependencyIndex: index }, async ({ owner, repo, index, dependencyOwner, dependencyRepo, dependencyIndex, reason }) => result({ outcome: 'verified', reason, dependencies: await forgejo.removeDependency(owner, repo, index, { owner: dependencyOwner, repo: dependencyRepo, index: dependencyIndex }) }))
  read('discover_issue_fields', 'Discover valid labels, milestones, and collaborators before planning-field writes.', repoRef, async ({ owner, repo }) => result({ labels: await forgejo.listLabels(owner, repo), milestones: await forgejo.listMilestones(owner, repo), collaborators: await forgejo.listCollaborators(owner, repo) }))
  write('set_issue_labels', 'Replace issue labels with discovered label IDs and read the issue back.', { ...repoRef, index, labels: z.array(z.number().int().positive()).max(50) }, async ({ owner, repo, index, labels, reason }) => result({ outcome: 'verified', reason, issue: await forgejo.setIssueLabels(owner, repo, index, labels) }))
  read('list_time_entries', 'List tracked time for an issue.', { ...repoRef, index }, async ({ owner, repo, index }) => result(await forgejo.listTrackedTime(owner, repo, index)))
  write('add_time_entry', 'Add bounded time in seconds to an issue and verify the time list.', { ...repoRef, index, seconds: z.number().int().min(1).max(31_536_000), userName: z.string().min(1).max(255).optional() }, async ({ owner, repo, index, seconds, userName, reason }) => result({ outcome: 'verified', reason, entries: await forgejo.addTrackedTime(owner, repo, index, seconds, userName) }))
  read('list_issue_attachments', 'List attachments on an issue or pull request.', { ...repoRef, index }, async ({ owner, repo, index }) => result(await forgejo.listAttachments(owner, repo, index)))
  write('upload_issue_attachment', 'Upload a base64 attachment with a strict 2 MiB and media-type allowlist, then verify the attachment list.', { ...repoRef, index, filename: z.string().min(1).max(128), mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/markdown', 'application/json', 'application/pdf', 'application/zip']), base64: z.string().min(1).max(2_800_000) }, async ({ owner, repo, index, filename, mediaType, base64, reason }) => result({ outcome: 'verified', reason, attachments: await forgejo.uploadAttachment(owner, repo, index, filename, mediaType, base64) }))

  read('list_pull_requests', 'List pull requests.', { ...repoRef, state: z.enum(['open', 'closed', 'all']).default('open'), page, limit }, async ({ owner, repo, state, page, limit }) => result(await forgejo.listPullRequests(owner, repo, state, page, limit)))
  read('get_pull_request', 'Read pull-request metadata.', { ...repoRef, index }, async ({ owner, repo, index }) => result(await forgejo.getPullRequest(owner, repo, index)))
  write('create_pull_request', 'Create an idempotent draft or regular PR from an existing branch and read it back.', { ...repoRef, title: z.string().min(1).max(255), body: z.string().max(1_000_000).optional(), head: z.string().min(1).max(255), base: z.string().min(1).max(255), draft: z.boolean().default(true), idempotencyKey }, async ({ owner, repo, reason, confirmed: _confirmed, body, ...input }) => result({ outcome: 'verified', reason, ...(await forgejo.createPullRequest(owner, repo, { ...input, ...(body !== undefined ? { body } : {}) })) }))
  write('update_pull_request', 'Update pull-request metadata and read it back; merging is intentionally unavailable.', { ...repoRef, index, title: z.string().min(1).max(255).optional(), body: z.string().max(1_000_000).optional(), state: z.enum(['open', 'closed']).optional(), base: z.string().min(1).max(255).optional(), assignees: z.array(z.string()).max(20).optional(), labels: z.array(z.number().int().positive()).max(50).optional(), milestone: z.number().int().nonnegative().optional() }, async ({ owner, repo, index, reason, confirmed: _confirmed, ...fields }) => result({ outcome: 'verified', reason, pullRequest: await forgejo.updatePullRequest(owner, repo, index, fields) }))
  read('get_pull_changes', 'List files and commits in a pull request.', { ...repoRef, index }, async ({ owner, repo, index }) => result({ files: await forgejo.listPullFiles(owner, repo, index), commits: await forgejo.listPullCommits(owner, repo, index) }))
  read('list_pull_reviews', 'List pull-request reviews.', { ...repoRef, index }, async ({ owner, repo, index }) => result(await forgejo.listPullReviews(owner, repo, index)))
  write('create_pull_review', 'Submit and read back a COMMENT, APPROVE, or REQUEST_CHANGES review.', { ...repoRef, index, event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']), body: z.string().max(1_000_000).optional(), commitId: z.string().max(64).optional() }, async ({ owner, repo, index, event, body, commitId, reason }) => result({ outcome: 'verified', reason, review: await forgejo.createPullReview(owner, repo, index, { event, body, commit_id: commitId }) }))
  write('request_pull_reviewers', 'Request discovered users or teams as reviewers and read the PR back.', { ...repoRef, index, reviewers: z.array(z.string().min(1).max(255)).max(20).default([]), teams: z.array(z.string().min(1).max(255)).max(20).default([]) }, async ({ owner, repo, index, reviewers, teams, reason }) => result({ outcome: 'verified', reason, pullRequest: await forgejo.requestReviewers(owner, repo, index, reviewers, teams) }))

  read('list_commits', 'List repository commits.', { ...repoRef, sha: z.string().max(255).optional(), page, limit }, async ({ owner, repo, sha, page, limit }) => result(await forgejo.listCommits(owner, repo, sha, page, limit)))
  read('get_commit_status', 'Read a commit and its combined and individual statuses.', { ...repoRef, ref: z.string().min(1).max(255) }, async ({ owner, repo, ref }) => result({ commit: await forgejo.getCommit(owner, repo, ref), combined: await forgejo.getCombinedStatus(owner, repo, ref), statuses: await forgejo.listStatuses(owner, repo, ref) }))
  read('list_action_runs', 'List bounded Forgejo Actions runs.', { ...repoRef, page, limit: z.number().int().min(1).max(50).default(30) }, async ({ owner, repo, page, limit }) => result(await forgejo.listActionRuns(owner, repo, page, limit)))
  read('get_action_run', 'Read an Actions run and its jobs.', { ...repoRef, runId: index }, async ({ owner, repo, runId }) => result({ run: await forgejo.getActionRun(owner, repo, runId), jobs: await forgejo.listActionJobs(owner, repo, runId) }))
  read('get_action_job_log', 'Read a bounded Actions job log for diagnosis.', { ...repoRef, jobId: index }, async ({ owner, repo, jobId }) => result({ job: await forgejo.getActionJob(owner, repo, jobId), log: await forgejo.getActionJobLog(owner, repo, jobId) }))
  read('list_action_artifacts', 'List artifact metadata without downloading artifact contents.', { ...repoRef, runId: index.optional() }, async ({ owner, repo, runId }) => result(await forgejo.listActionArtifacts(owner, repo, runId)))
  read('get_action_artifact', 'Read one Actions artifact metadata record without downloading it.', { ...repoRef, artifactId: index }, async ({ owner, repo, artifactId }) => result(await forgejo.getActionArtifact(owner, repo, artifactId)))

  read('list_notifications', 'List global or repository notifications.', { owner: repoRef.owner.optional(), repo: repoRef.repo.optional(), all: z.boolean().default(false) }, async ({ owner, repo, all }) => { if ((owner === undefined) !== (repo === undefined)) throw new Error('owner and repo must be supplied together.'); return result(await forgejo.listNotifications(owner, repo, all)) })
  read('get_notification', 'Read one notification thread.', { id: index }, async ({ id }) => result(await forgejo.getNotification(id)))
  write('mark_notification_read', 'Mark one notification thread read and verify it.', { id: index }, async ({ id, reason }) => result({ outcome: 'verified', reason, notification: await forgejo.markNotificationRead(id) }))
  read('list_organizations', 'List organizations available to the provider identity.', {}, async () => result(await forgejo.listOrganizations()))
  read('list_organization_teams', 'List teams in an organization.', { organization: repoRef.owner }, async ({ organization }) => result(await forgejo.listOrganizationTeams(organization)))
  read('list_repository_teams', 'List teams with repository access.', repoRef, async ({ owner, repo }) => result(await forgejo.listRepositoryTeams(owner, repo)))
  read('list_team_members', 'List members of a discovered team.', { teamId: index }, async ({ teamId }) => result(await forgejo.listTeamMembers(teamId)))
  read('list_releases_and_tags', 'List releases and tags.', repoRef, async ({ owner, repo }) => result({ releases: await forgejo.listReleases(owner, repo), tags: await forgejo.listTags(owner, repo) }))
  read('list_branch_protections', 'List branch-protection rules.', repoRef, async ({ owner, repo }) => result(await forgejo.listBranchProtections(owner, repo)))
  read('get_branch_protection', 'Read one branch-protection rule.', { ...repoRef, name: z.string().min(1).max(255) }, async ({ owner, repo, name }) => result(await forgejo.getBranchProtection(owner, repo, name)))
  read('list_webhooks', 'List repository webhooks without exposing secrets.', repoRef, async ({ owner, repo }) => result(await forgejo.listWebhooks(owner, repo)))
  read('get_webhook', 'Read one repository webhook configuration.', { ...repoRef, id: index }, async ({ owner, repo, id }) => result(await forgejo.getWebhook(owner, repo, id)))
  write('test_webhook', 'Request one existing webhook test delivery and verify the hook still exists.', { ...repoRef, id: index }, async ({ owner, repo, id, reason }) => result({ outcome: 'verified', reason, webhook: await forgejo.testWebhook(owner, repo, id) }), false)

  if (oauth) {
    registerConnectionTools(server, {
      id: 'forgejo', label: 'Forgejo', oauth,
      connectDescription: 'Start a one-time Forgejo sign-in for the calling user. Returns a link to open in your browser, where Forgejo asks you to approve access. After approval this server calls Forgejo as you; nothing needs to be pasted.',
      disconnectDescription: 'Forget the calling user\'s stored Forgejo grant on this server. To revoke it at Forgejo too, remove the application under Settings → Applications in Forgejo.',
      alreadyConnectedNote: 'Forgejo is already connected for you. Call disconnect_forgejo first to connect a different account.',
      connectNote: 'Open this link in the browser where you are signed in to Forgejo as yourself, check the account shown, and approve.'
    })
    server.registerTool('get_forgejo_connection', {
      description: 'Report whether the calling user has connected Forgejo.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, async (context: Context) => {
      const subject = subjectOf(context)
      const extra = context?.http?.authInfo?.extra
      return result({ caller: context?.http?.authInfo?.clientId ?? 'stdio-client', oauthClient: extra?.authorizedParty, tokenAudience: extra?.audience, forgejoConnection: context?.http?.req?.headers.get(FORGEJO_TOKEN_HEADER) ? 'token-header' : subject ? ((await oauth.isConnected(subject)) ? 'connected' : 'not-connected') : 'unavailable' })
    })
  }

  return server
}
