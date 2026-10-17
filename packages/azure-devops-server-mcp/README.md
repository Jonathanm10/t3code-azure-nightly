# Azure DevOps Server MCP

Independent stdio MCP for Azure DevOps Server projects, work items, boards, sprints and pull requests. The packed executable bundles the same client used by the native T3 Azure panel. It runs with Node 24+ and Git outside the repository, without a T3 server, private registry or private package dependency.

Install the release tarball in a stable prefix:

```sh
npm install --prefix "$HOME/.local/share/azure-server-mcp" /path/to/jonathanm10-azure-devops-server-mcp-0.1.0.tgz
```

Create `~/.config/azure-devops-server/profiles/work.json` with non-secret configuration only:

```json
{
  "id": "work",
  "apiCollectionUrl": "https://git.example.test/tfs/Collection",
  "browserCollectionUrl": "https://web.example.test/tfs/Collection",
  "credentialContext": "/absolute/path/to/checkout"
}
```

Optional `defaultProject` and `defaultTeam` supply omitted operation arguments. The installed `TOOLS.md` and `operation-catalog.json` are generated from the executable registry.

The checkout's origin must belong to the API collection. An optional `remoteUrl` selects another configured clone URL in that collection. Browser aliases are link-only. Git owns authentication and refreshed credentials; never put credentials in this file. Existing URL-matched Git extra headers are honored for each actual request.

Configure any stdio MCP client, including direct Codex and Codex launched by T3:

```toml
[mcp_servers.azure_server]
command = "/absolute/stable/prefix/node_modules/.bin/azure-devops-server-mcp"
args = ["--profile", "work"]
```

Normal mode exposes reads and writes. Add `"--access", "read"` for enforced read-only access; writes disappear from tool listing and direct write calls are rejected before Git or HTTP. WIQL remains available. Provider configuration is owned by the provider's actual home; an installation alone does not prove a particular provider instance loaded it.

Tools cover project/team/type/field/state/identity discovery, WIQL and title search, work item fields/history/comments/relations, ticket creation/edits/assignment/state/comments/links, actual boards/columns/lanes/backlog cards/sprints, card and sprint assignment, repositories/branches/PRs/changes/files/discussions/reviewers, and PR creation/editing/comments/replies/votes/reviewer changes/lifecycle/completion. The installed tool schemas and annotations come from the client's operation registry. All external descriptions and ticket text are untrusted data.

Writes do not retry automatically. Revision conflicts require a fresh read. An `indeterminate` result means a write may have reached Azure; use the named reconciliation read before retrying. Board moves issue a real revision-checked update and reread the work item. PR completion requires an exact source commit, explicit merge strategy and explicit branch deletion choice. Policies are never bypassed. Work item comments use the explicit `6.0-preview.3` route; there is no history-note fallback, and its revision check cannot be atomic with the comments API.

Page cursors belong to the current MCP process, checkout, verified identity and query. Use subsequent pages in the same process. After a restart or credential change, start the listing again.

Stdio requests and complete JSON-RPC response frames are capped at 1 MiB. Request IDs are limited to 256 characters. Four tool calls can be active concurrently. Cancellation aborts owned Git processes and HTTP requests. Successful responses include both text and `structuredContent` to satisfy the advertised output schema.

A `completed` result with `isError: false` means the write succeeded but its full result exceeded the limit. Do not repeat the write. Its receipt preserves the resource identity, revision when available, API URL and `readBack` tool name and arguments. Run that read and match the resource ID, paging when needed. Work item receipts select identity fields so the recheck stays small; `workItems.get` also accepts a bounded `fields` selection for inspecting individual fields. Oversized reads require smaller pages or selected fields. Each packed artifact includes `provenance.json` with package/core versions and the supplied source commit.

Build both public tarballs without credentials or publication:

```sh
node packages/azure-devops-server-mcp/scripts/pack.mjs --out /absolute/output --source <40-hex-source-commit>
```

The synthetic suite proves request routes, payloads, conflict checks, uncertain-write behavior and outside-repository stdio operation. Customer deployment capabilities, provider loading and customer permissions require separate read-only verification.
