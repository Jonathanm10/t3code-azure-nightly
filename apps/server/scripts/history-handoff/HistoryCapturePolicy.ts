// @effect-diagnostics nodeBuiltinImport:off - This synchronous SQLite admission boundary hashes exact metadata bytes before any row is read.
import * as NodeCrypto from "node:crypto";
import type * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import { migrationManifest } from "../../src/persistence/Migrations.ts";

export const historyTables = [
  {
    name: "auth_pairing_links",
    disposition: "empty-operational",
    columns: [
      "id",
      "credential",
      "method",
      "scopes",
      "subject",
      "label",
      "created_at",
      "expires_at",
      "consumed_at",
      "revoked_at",
      "proof_key_thumbprint",
    ],
    definitionHash: "28a1cc2e26f6afcecc14945020d94fb43c29f3b9ead048667e077d76bf4a5de9",
    columnsHash: "2681556d6aa7745ac84ddcd049a1cc60818e3b1680c9c714dc2c3ec682ce7418",
  },
  {
    name: "auth_sessions",
    disposition: "empty-operational",
    columns: [
      "session_id",
      "subject",
      "scopes",
      "method",
      "client_label",
      "client_ip_address",
      "client_user_agent",
      "client_device_type",
      "client_os",
      "client_browser",
      "issued_at",
      "expires_at",
      "last_connected_at",
      "revoked_at",
    ],
    definitionHash: "5f4991e0667724f1197821d78e3ddd95824ff4105870c2e6ea7e69bcfd85464b",
    columnsHash: "71e49b80d0701a7c0dd707b21d0b382d6c7ef42df214b7b499007d1d32621c33",
  },
  {
    name: "checkpoint_diff_blobs",
    disposition: "copy-history",
    columns: ["thread_id", "from_turn_count", "to_turn_count", "diff", "created_at"],
    definitionHash: "887b0c871c1fec29ae61d3c8984020cc335a8631d8e71aa4685b2be7dd7d1a4f",
    columnsHash: "c1c3089809573275ad68c5505c428843dbd219e866362335e3309266e3137db0",
  },
  {
    name: "effect_sql_migrations",
    disposition: "fresh-schema-only",
    columns: ["migration_id", "created_at", "name"],
    definitionHash: "b7805fe5d8d27ecf72e91c7d7283d5961fc4e6d78943820ce21f0facd41c9bdc",
    columnsHash: "7baf1f0de8057d14d7798d9c9639396d6eef20473ce03c84161f8e3142acf86f",
  },
  {
    name: "mcp_app_model_context",
    disposition: "copy-history",
    columns: ["thread_id", "item_id", "server", "tool", "text", "updated_at"],
    definitionHash: "0c246624fe35b1e443b9bf13dbf56fba6e893739f1bc3f1df09eb289dc86d18f",
    columnsHash: "9011506afce3342588bc8f4e112c01ffb512386be99912182f3178ff8365ecc5",
  },
  {
    name: "orchestration_command_receipts",
    disposition: "empty-operational",
    columns: [
      "command_id",
      "aggregate_kind",
      "aggregate_id",
      "accepted_at",
      "result_sequence",
      "status",
      "error",
      "command_type",
    ],
    definitionHash: "7867a6e9f3b2228aa456fa9619c95abc1b067850dcd33c21389cc6b1dd448bec",
    columnsHash: "8f1238e9c3cd0c2bf7ddaa61a683e3856339fc332ce5c9de28b6bcbc7b2fad1f",
  },
  {
    name: "orchestration_events",
    disposition: "copy-history",
    columns: [
      "sequence",
      "event_id",
      "aggregate_kind",
      "stream_id",
      "stream_version",
      "event_type",
      "occurred_at",
      "command_id",
      "causation_event_id",
      "correlation_id",
      "actor_kind",
      "payload_json",
      "metadata_json",
      "application_event_version",
    ],
    definitionHash: "fb067efeb0cb23f9402a1970e77dc24ad48101c7157053e8a9136c6e572f0659",
    columnsHash: "4e912915f47d269c7982ac8a9320346657718529186cae3c69b6169ffd13f641",
  },
  {
    name: "orchestration_v2_command_receipts",
    disposition: "empty-operational",
    columns: [
      "command_id",
      "thread_id",
      "command_type",
      "accepted_at",
      "result_sequence",
      "status",
      "error",
    ],
    definitionHash: "21ec41a15db1aa4142944607bb4532f9aab5151e713f3655de21ad70b4fe0bd4",
    columnsHash: "69d7bd319802f02f4e3fd8d22bbb72b2f605cf8407cb22caa5b51cb424449fbd",
  },
  {
    name: "orchestration_v2_effect_outbox",
    disposition: "empty-operational",
    columns: [
      "effect_id",
      "command_id",
      "thread_id",
      "effect_type",
      "payload_json",
      "status",
      "attempt_count",
      "available_at",
      "lease_owner",
      "lease_expires_at",
      "created_at",
      "updated_at",
      "completed_at",
      "last_error",
    ],
    definitionHash: "e10fc1c55db701fc0e6e82b45ec926e907ce58d0b7ff506cc9257724893e1a51",
    columnsHash: "394769bbed58c59238cef126d3d5d075b8a06382afbe9bba0359fde9137df8c7",
  },
  {
    name: "orchestration_v2_events",
    disposition: "copy-history",
    columns: [
      "sequence",
      "event_id",
      "command_id",
      "thread_id",
      "run_id",
      "node_id",
      "provider",
      "raw_event_id",
      "event_type",
      "occurred_at",
      "payload_json",
      "driver",
      "provider_instance_id",
    ],
    definitionHash: "167d7e2e03baa27c0ede0e961a8cb9e428856967f479c64ab420eea6073cb86c",
    columnsHash: "8d77f3ab6dd0c6079233c29ee2ca12a28c0d722f2e0d2a40e4fbdf21e057d54f",
  },
  {
    name: "orchestration_v2_legacy_imports",
    disposition: "copy-history",
    columns: [
      "thread_id",
      "source_updated_at",
      "shell_imported_at",
      "transcript_imported_at",
      "imported_message_count",
      "last_error",
    ],
    definitionHash: "11e09501c015b4c0f06ce18f684f5f394e862afaa1c7808972e8f629c0ff440e",
    columnsHash: "c86f5bcbf62dba25f3452ac3a1af5db34d420b63f074254406a10184a21b70c2",
  },
  {
    name: "orchestration_v2_projection_checkpoint_scopes",
    disposition: "copy-history",
    columns: [
      "scope_id",
      "thread_id",
      "run_id",
      "node_id",
      "parent_scope_id",
      "provider_thread_id",
      "kind",
      "ordinal_within_parent",
      "advances_app_run_count",
      "created_at",
      "payload_json",
    ],
    definitionHash: "faa927b68b58d39191c85906aaebafe906f57035659c335f39690610b5b224c4",
    columnsHash: "37b34ddec650b344a52e477bc9aa5b2b1a64f27cfbdbecb8ab60ab4fe5266e71",
  },
  {
    name: "orchestration_v2_projection_checkpoints",
    disposition: "copy-history",
    columns: [
      "checkpoint_id",
      "thread_id",
      "scope_id",
      "run_id",
      "node_id",
      "parent_checkpoint_id",
      "ordinal_within_scope",
      "app_run_ordinal",
      "status",
      "captured_at",
      "payload_json",
    ],
    definitionHash: "b1125a3022c363f9a10b0005274070574b0ff15a37764750ec3b2b6ae6386c69",
    columnsHash: "5042d4d13996f69f4c904f114d0ce34ae5f4644b7dddfa0d4314cc2db1f0322a",
  },
  {
    name: "orchestration_v2_projection_context_handoffs",
    disposition: "copy-history",
    columns: [
      "context_handoff_id",
      "thread_id",
      "target_run_id",
      "to_provider_thread_id",
      "strategy",
      "status",
      "updated_at",
      "payload_json",
    ],
    definitionHash: "b67109cf4985b994a70415d35446420a847eed0614d708dff26355d0611fd04e",
    columnsHash: "dc2150a7ee53276b951e95b782593e3a78e70361be2ff8fef528b4759416cd7d",
  },
  {
    name: "orchestration_v2_projection_context_transfers",
    disposition: "copy-history",
    columns: [
      "context_transfer_id",
      "source_thread_id",
      "target_thread_id",
      "target_run_id",
      "type",
      "status",
      "source_provider",
      "target_provider",
      "updated_at",
      "payload_json",
      "source_provider_instance_id",
      "target_provider_instance_id",
    ],
    definitionHash: "e47e0a580dd020d0370bfb0c84212db236c79998758357d626fbcf9263d8235f",
    columnsHash: "f452989e6e09f533d7f21adfc1d0e8a651e3481af687aa4931be9fc7c76c5138",
  },
  {
    name: "orchestration_v2_projection_messages",
    disposition: "copy-history",
    columns: [
      "message_id",
      "thread_id",
      "run_id",
      "node_id",
      "role",
      "streaming",
      "created_at",
      "updated_at",
      "payload_json",
    ],
    definitionHash: "06c34fcfdc3f0485a4b2c2a6ff32fcd6bb647fd5bbfb101b99fdd3c0d68dd4ab",
    columnsHash: "e970b3e07bd8e0c54d10d16feeee8c23b97af30f233d07dbbb49241a753cbb3a",
  },
  {
    name: "orchestration_v2_projection_metadata",
    disposition: "copy-history",
    columns: ["projection_name", "schema_version", "last_sequence", "updated_at"],
    definitionHash: "a0dc31bf91b6712c15f9c034d6006659dfb7a284caf8d44de9a5fc2d50f13509",
    columnsHash: "947c7527820cb87fedfd8a32f09684641600885d338e7b03ba9888448b02098b",
  },
  {
    name: "orchestration_v2_projection_nodes",
    disposition: "copy-history",
    columns: [
      "node_id",
      "thread_id",
      "run_id",
      "parent_node_id",
      "root_node_id",
      "kind",
      "status",
      "provider_thread_id",
      "provider_turn_id",
      "runtime_request_id",
      "checkpoint_scope_id",
      "started_at",
      "completed_at",
      "payload_json",
    ],
    definitionHash: "1fb5d0ac0c2068216c459100173161f5b0831f1b1648d00f96995b69ae404002",
    columnsHash: "d7aaa03e00cb9ffc68834025f17c0ebcb35dfd35cbde9e114efd61fb887487ac",
  },
  {
    name: "orchestration_v2_projection_plans",
    disposition: "copy-history",
    columns: ["plan_id", "thread_id", "run_id", "node_id", "kind", "status", "payload_json"],
    definitionHash: "ef1325295e34b856b5ece6b6d243eb1753f6afd6a389b2e81f83fe2fa37a382f",
    columnsHash: "e26350df9aa50d3bb2d0e565052ee1779259f1a4eef826affc628f221b12b3e2",
  },
  {
    name: "orchestration_v2_projection_provider_session_bindings",
    disposition: "copy-history",
    columns: ["provider_session_id", "thread_id"],
    definitionHash: "4185d0aea039a8ea225f1c9e08649afb0733984c66f96f7f94bc381067837573",
    columnsHash: "0066662ca55b8c4a451f299f3d348b7ffc0fc78a3e078d01b9a8140b742bb5f0",
  },
  {
    name: "orchestration_v2_projection_provider_sessions",
    disposition: "copy-history",
    columns: [
      "provider_session_id",
      "thread_id",
      "provider",
      "status",
      "model",
      "updated_at",
      "payload_json",
      "driver",
      "provider_instance_id",
    ],
    definitionHash: "0134100b3672a772f0f02187544742649abe15398ef851fc0d6d5b4589de02ec",
    columnsHash: "6cb3e8e53699590aedce822d9ed2171c814f0f37f10157b2e4846558f2d4fc97",
  },
  {
    name: "orchestration_v2_projection_provider_threads",
    disposition: "copy-history",
    columns: [
      "provider_thread_id",
      "thread_id",
      "owner_node_id",
      "provider",
      "provider_session_id",
      "status",
      "first_run_ordinal",
      "last_run_ordinal",
      "updated_at",
      "payload_json",
      "driver",
      "provider_instance_id",
    ],
    definitionHash: "a15d22da61fff14530f8b0aac7991b7e0a77c5abe58b7681e7ddb46c52f18200",
    columnsHash: "fea580a141dda3d2f471ca97f7aedfccd6e8307af94644693c0fc11fe3fc479a",
  },
  {
    name: "orchestration_v2_projection_provider_turns",
    disposition: "copy-history",
    columns: [
      "provider_turn_id",
      "thread_id",
      "provider_thread_id",
      "node_id",
      "run_attempt_id",
      "ordinal",
      "status",
      "started_at",
      "completed_at",
      "payload_json",
    ],
    definitionHash: "4a1308b53ed4cf34f4eb1325f05eed37b8ace7a8668b146c696c726950b0c3a6",
    columnsHash: "73e42161733ea9f7fee6e68b1f8b07e1d3171e584934d5dcaf798df593363bab",
  },
  {
    name: "orchestration_v2_projection_run_attempts",
    disposition: "copy-history",
    columns: [
      "attempt_id",
      "thread_id",
      "run_id",
      "attempt_ordinal",
      "root_node_id",
      "provider",
      "provider_thread_id",
      "provider_turn_id",
      "status",
      "payload_json",
      "provider_instance_id",
    ],
    definitionHash: "48dd545fd1291314fbe435f4b23886354e8220f8399ce2125f75adca61a287ab",
    columnsHash: "450762cff42ab10c763f422392a6eb3cdf59602cb4ba9027b779349921324cd1",
  },
  {
    name: "orchestration_v2_projection_runs",
    disposition: "copy-history",
    columns: [
      "run_id",
      "thread_id",
      "ordinal",
      "provider",
      "provider_thread_id",
      "status",
      "requested_at",
      "completed_at",
      "payload_json",
      "provider_instance_id",
    ],
    definitionHash: "887aded5e5857975a40a63488edbb2193f10b42c1873ca0c020d6f5045064ec2",
    columnsHash: "2c4362141d2b52a3b4f716ef3dbed41a45593fa5f3021b53a502a7be351f7b53",
  },
  {
    name: "orchestration_v2_projection_runtime_requests",
    disposition: "copy-history",
    columns: [
      "runtime_request_id",
      "thread_id",
      "node_id",
      "provider_turn_id",
      "kind",
      "status",
      "created_at",
      "resolved_at",
      "payload_json",
    ],
    definitionHash: "580d3174dc6b0b1ac8df23c9989715b991a7a58dac4a49b6878b8a0bf73f6f2a",
    columnsHash: "471ada0be883b3621fabe859b36851adfef27ec3e740791e9f60239e346dfcbf",
  },
  {
    name: "orchestration_v2_projection_subagents",
    disposition: "copy-history",
    columns: [
      "subagent_id",
      "thread_id",
      "run_id",
      "parent_node_id",
      "provider",
      "provider_thread_id",
      "child_thread_id",
      "origin",
      "status",
      "started_at",
      "completed_at",
      "updated_at",
      "payload_json",
      "driver",
      "provider_instance_id",
    ],
    definitionHash: "9fdffeaaec55f2d27d6f8fd6c178bbe5388048bc25983899ba95827dba6163a3",
    columnsHash: "cf59b991b7e0c3d1f851d69af60a10b6ddb711528f115fce9b32e0773154f3d3",
  },
  {
    name: "orchestration_v2_projection_threads",
    disposition: "copy-history",
    columns: [
      "thread_id",
      "project_id",
      "title",
      "default_provider",
      "runtime_mode",
      "interaction_mode",
      "active_provider_thread_id",
      "created_at",
      "updated_at",
      "archived_at",
      "deleted_at",
      "payload_json",
      "provider_instance_id",
    ],
    definitionHash: "b42c8d0191187ff7b6c2664a2e95a1f6c2cc09bf81ef079701ce86497a7e0e58",
    columnsHash: "25b5f72e5e522722f84780d673e9ba2de0fb53e216a27fdfd02a7a92336c7aa0",
  },
  {
    name: "orchestration_v2_projection_turn_items",
    disposition: "copy-history",
    columns: [
      "turn_item_id",
      "thread_id",
      "run_id",
      "node_id",
      "provider_thread_id",
      "provider_turn_id",
      "parent_item_id",
      "ordinal",
      "type",
      "status",
      "updated_at",
      "payload_json",
    ],
    definitionHash: "58605e7ce688d3ae7b9125bcd5438926ff8afb7bd3b2b12c0e5527e1a546e810",
    columnsHash: "38135f7adea1e6faba6d35acdab34c268c9363b501ebcf0588f0729d91e08d01",
  },
  {
    name: "orchestration_v2_thread_launch_workflows",
    disposition: "empty-operational",
    columns: [
      "command_id",
      "thread_id",
      "project_id",
      "status",
      "title",
      "worktree_path",
      "branch",
      "setup_committed",
      "thread_committed",
      "message_committed",
      "last_error",
      "created_at",
      "updated_at",
    ],
    definitionHash: "95ce1479d8e4c38de6dc415b2cddd2d871d3929bf706a518afa7006fd0eacc4b",
    columnsHash: "343de9a97b27a86446dfd7279f5db88a15cf731ce4f0128f79bd80f0541d67b2",
  },
  {
    name: "orchestration_v2_turn_item_positions",
    disposition: "copy-history",
    columns: ["thread_id", "turn_item_id", "ordinal"],
    definitionHash: "0ae822ef5c75bf51348fbce952e7052809a979755c2089b377628e3ed46831e9",
    columnsHash: "6bfdf47a64f66eb3e1d5a6e3b3a0f38d1c7513006036fab650f413bb19824968",
  },
  {
    name: "projection_pending_approvals",
    disposition: "empty-operational",
    columns: [
      "request_id",
      "thread_id",
      "turn_id",
      "status",
      "decision",
      "created_at",
      "resolved_at",
    ],
    definitionHash: "4c24f2abdfafe4950a8ee3e4c0f77ca81e12097ff80201e11760439c38dbd6a3",
    columnsHash: "807fec8645d9d6739a3b3b6eba5936d6ef79b981eba2fdc127efa49d91744afc",
  },
  {
    name: "projection_projects",
    disposition: "copy-history",
    columns: [
      "project_id",
      "title",
      "workspace_root",
      "scripts_json",
      "created_at",
      "updated_at",
      "deleted_at",
      "default_model_selection_json",
      "default_thread_env_mode",
      "favicon_path",
      "auto_pull",
      "project_icon_json",
    ],
    definitionHash: "ff37f90fc4e0c251581c74b2c969191928f4b2ef5c533c8a2e3a2ce2c5d73d89",
    columnsHash: "cebba8ad3bff8f036df17367dad53f674657f7512a02a2da97a833e3258ffc06",
  },
  {
    name: "projection_state",
    disposition: "fresh-schema-only",
    columns: ["projector", "last_applied_sequence", "updated_at"],
    definitionHash: "b269924c519f9c8fd1ab91fd7e271433ca5733adab4ba14bb0e2a030efd3980e",
    columnsHash: "709ea56850b413be2c135bf6b51b5ef957d6385ed1f1caf1427b03b180064a1a",
  },
  {
    name: "projection_thread_activities",
    disposition: "copy-history",
    columns: [
      "activity_id",
      "thread_id",
      "turn_id",
      "tone",
      "kind",
      "summary",
      "payload_json",
      "created_at",
      "sequence",
    ],
    definitionHash: "4714b97ec2aeb5415dc1383bad7b905c4476c2426b48be9383408699ecbd844a",
    columnsHash: "41f15dc7136f529373f00b99692fb49114d4aa1d38b2660f9f7a8d6c7cefb8f7",
  },
  {
    name: "projection_thread_messages",
    disposition: "copy-history",
    columns: [
      "message_id",
      "thread_id",
      "turn_id",
      "role",
      "text",
      "is_streaming",
      "created_at",
      "updated_at",
      "attachments_json",
      "context_json",
    ],
    definitionHash: "239b45875565914e22fd271058c2fb0162b88b0614c25e7cf5c4497b49c3cf13",
    columnsHash: "2277c4c9993163d8f016ff6dcf42edd573a9b099b5fdb3a8af3bc66a6b836122",
  },
  {
    name: "projection_thread_proposed_plans",
    disposition: "copy-history",
    columns: [
      "plan_id",
      "thread_id",
      "turn_id",
      "plan_markdown",
      "created_at",
      "updated_at",
      "implemented_at",
      "implementation_thread_id",
    ],
    definitionHash: "8ded689ba6c1c11f7d84326318387cda592d80e595446197f5e928ef65916075",
    columnsHash: "3d94817fa9f4fbc11c96ec98e4575f07bfa0b88f557a447bb7bdfb17162bce19",
  },
  {
    name: "projection_thread_pull_requests",
    disposition: "copy-history",
    columns: [
      "thread_id",
      "host",
      "repository",
      "number",
      "url",
      "source",
      "linked_at",
      "snapshot_json",
      "stack_json",
    ],
    definitionHash: "403ca9a61f4a7ff3e27e068398b2ecaee3638315c2ebd150c769a5147989bead",
    columnsHash: "b590bcd9e9ed585ea462950f3af887d1ceb765a497a8fe6cd7f45e0ae53290e0",
  },
  {
    name: "projection_thread_sessions",
    disposition: "copy-history",
    columns: [
      "thread_id",
      "status",
      "provider_name",
      "provider_session_id",
      "provider_thread_id",
      "active_turn_id",
      "last_error",
      "updated_at",
      "runtime_mode",
      "provider_instance_id",
    ],
    definitionHash: "c88c4c776f49ba34e7f86b7a39f54b076bcbf1a95af3f9b24287beb1a71f3f88",
    columnsHash: "52d12ccde71e326d9a38aa8552ea295a3862321e0806ae94d3c702191f67ebc7",
  },
  {
    name: "projection_threads",
    disposition: "copy-history",
    columns: [
      "thread_id",
      "project_id",
      "title",
      "branch",
      "worktree_path",
      "latest_turn_id",
      "created_at",
      "updated_at",
      "deleted_at",
      "runtime_mode",
      "interaction_mode",
      "model_selection_json",
      "archived_at",
      "latest_user_message_at",
      "pending_approval_count",
      "pending_user_input_count",
      "has_actionable_proposed_plan",
      "settled_override",
      "settled_at",
      "snoozed_until",
      "snoozed_at",
      "title_regeneration_request_id",
      "title_regeneration_started_at",
      "pinned_at",
      "pin_order_key",
      "linked_pull_request_json",
      "unsettled_at",
      "branch_pull_request_json",
      "active_order_key",
      "title_state_json",
      "auto_settle_disabled_at",
    ],
    definitionHash: "bd68497bf6fbe059f170e45597202bc12c42e682627cd7c72f029b7027ae9802",
    columnsHash: "4296f91d4723bd34c32b0dcf65087f723524e08fbdaeb08d283fb4c863ed2b40",
  },
  {
    name: "projection_turns",
    disposition: "copy-history",
    columns: [
      "row_id",
      "thread_id",
      "turn_id",
      "pending_message_id",
      "assistant_message_id",
      "state",
      "requested_at",
      "started_at",
      "completed_at",
      "checkpoint_turn_count",
      "checkpoint_ref",
      "checkpoint_status",
      "checkpoint_files_json",
      "source_proposed_plan_thread_id",
      "source_proposed_plan_id",
      "reasoning_json",
    ],
    definitionHash: "dfc0dc9786a8c68a0353930016f135e2a16bf7be64060faf7930df09a3eb1ef8",
    columnsHash: "c474382b70b4360adfeec443a7fb01b0c7143fc9eec70bd1aa6c37a210e59701",
  },
  {
    name: "provider_session_runtime",
    disposition: "empty-operational",
    columns: [
      "thread_id",
      "provider_name",
      "adapter_key",
      "runtime_mode",
      "status",
      "last_seen_at",
      "resume_cursor_json",
      "runtime_payload_json",
      "provider_instance_id",
    ],
    definitionHash: "69503fc6a6f12d6e7dfdf8c8a6f3c58c861510b7d662d9d6248450ac68b1bc2e",
    columnsHash: "bf1bcfe0b75e3f8dc9ee48793ab1e5fcefaa2ef4e92ee3c0e781cecb0526e1aa",
  },
  {
    name: "pull_request_files_viewed",
    disposition: "copy-history",
    columns: [
      "provider",
      "host",
      "repository",
      "number",
      "viewer",
      "path",
      "revision",
      "viewed_at",
    ],
    definitionHash: "5d9523cdb5efd3d23e963c1bae95c0ddba8e32678e9b6176c9995f119d897351",
    columnsHash: "aad8da57561400b4380247fc77a3f66be1eb1d77db354b28d3acb2d3a5caa00b",
  },
  {
    name: "pull_request_review_guides",
    disposition: "copy-history",
    columns: ["host", "repository", "number", "guide_json"],
    definitionHash: "2c844e7c0674283f0122529ab6939866bb382bfdaefa1f9accaa6ee5f3372c24",
    columnsHash: "2cb20e09fc6c3c4c7973c092982fc0fe4e654c14fee36c401bbcc9f7680d3cad",
  },
  {
    name: "scheduled_task_webhook_deliveries",
    disposition: "empty-operational",
    columns: [
      "delivery_id",
      "task_id",
      "received_at",
      "method",
      "query",
      "headers_json",
      "body",
      "body_bytes",
      "body_truncated",
      "outcome",
      "signature_verified",
      "missing_fields_json",
      "rendered_prompt",
      "error",
    ],
    definitionHash: "c8113c68ceb1dd52c4a7ec3e83a564158d14336dd1350c3ae669b7aa13fb0233",
    columnsHash: "82b4758a30a615e7855a6ef2992b1563133e3c9d8414cdfb838e48053e8d4953",
  },
  {
    name: "scheduled_task_webhook_relay_deliveries",
    disposition: "empty-operational",
    columns: ["relay_delivery_id", "task_id", "seen_at"],
    definitionHash: "c41a022a494828d9d8263c51fb4b6a7d5b5391437544fe43d8b256fd91096fa9",
    columnsHash: "b0925266c1e3de148cf7871a595e3f02023bea0313533c4d47425d9020409c56",
  },
  {
    name: "scheduled_tasks",
    disposition: "empty-operational",
    columns: [
      "task_id",
      "title",
      "prompt",
      "enabled",
      "schedule_json",
      "project_id",
      "thread_id",
      "workspace_strategy_json",
      "model_selection_json",
      "runtime_mode",
      "interaction_mode",
      "created_by",
      "creation_source",
      "created_at",
      "updated_at",
      "next_run_at",
      "last_run_at",
      "last_run_status",
      "last_run_error",
      "run_count",
      "webhook_token",
      "webhook_secret",
    ],
    definitionHash: "8aeac49000dfcf1659a2d3e1a7759a53f7da83365801e0fd4502c6509d421c84",
    columnsHash: "985817faf1a9acd7cd8631de276d48090712b6abcf992415a5dea3a2dbfab094",
  },
] as const;

export class HistorySchemaRefused extends Schema.TaggedError<HistorySchemaRefused>()(
  "HistorySchemaRefused",
  {
    reason: Schema.String,
    table: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    return `History schema refused: ${this.reason}${this.table === undefined ? "" : ` (${this.table})`}`;
  }
}

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const tableSchema = Schema.Array(Schema.Struct({ name: Schema.String, sql: Schema.String }));
const columnSchema = Schema.Array(
  Schema.Struct({
    cid: Schema.Number,
    name: Schema.String,
    type: Schema.String,
    notnull: Schema.Number,
    dflt_value: Schema.NullOr(Schema.String),
    pk: Schema.Number,
  }),
);
const migrationSchema = Schema.Array(
  Schema.Struct({ migration_id: Schema.Number, name: Schema.String }),
);
const currentAuthDefinition = "1b6d96b81eab641fc176e3091928d3225055ea93b665f5024365dd6bc3f78507";
const currentAuthColumns = "f9ef9c3d9fe88a5feaa433b7ecb3cf290a463cba4593a3dc6b3235194526166a";
const expectedUniqueIndexes = "2e230c1606839be52b710c87f65c453531464b3fba022dcc4efbe6c1c716b549";

const legacySourceMigrationHash =
  "69339dc0950879116602628e65c953accdc8a958a1e9c2af249bbe3d2b298bf4";
const expectedMigrationHash = "74a03d352f96bad31b09f3142f18018f94271aa9f65d3f77f2f827e1ab3a590e";

function assertSchema(database: NodeSqlite.DatabaseSync, target: "source" | "destination") {
  if (hash(JSON.stringify(migrationManifest)) !== expectedMigrationHash) {
    throw new HistorySchemaRefused({ reason: "changed-build-migrations" });
  }
  const tables = Schema.decodeUnknownSync(tableSchema)(
    database
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(),
  );
  if (
    JSON.stringify(tables.map(({ name }) => name)) !==
    JSON.stringify(historyTables.map(({ name }) => name))
  ) {
    throw new HistorySchemaRefused({ reason: "table-inventory-mismatch" });
  }
  let currentAuthLayout = false;
  for (const policy of historyTables) {
    const table = tables.find(({ name }) => name === policy.name);
    const currentAuth =
      policy.name === "auth_sessions" &&
      table !== undefined &&
      hash(table.sql.replace(/\s+/g, " ").trim()) === currentAuthDefinition;
    if (policy.name === "auth_sessions") currentAuthLayout = currentAuth;
    const expectedDefinition = currentAuth ? currentAuthDefinition : policy.definitionHash;
    if (target === "destination" && policy.name === "auth_sessions" && !currentAuth) {
      throw new HistorySchemaRefused({ reason: "destination-auth-schema-mismatch" });
    }
    if (table === undefined || hash(table.sql.replace(/\s+/g, " ").trim()) !== expectedDefinition) {
      throw new HistorySchemaRefused({ reason: "table-definition-mismatch", table: policy.name });
    }
    const columns = Schema.decodeUnknownSync(columnSchema)(
      database.prepare(`PRAGMA table_info("${policy.name}")`).all(),
    );
    const signature = columns.map((c) => [c.cid, c.name, c.type, c.notnull, c.dflt_value, c.pk]);
    if (
      hash(JSON.stringify(signature)) !== (currentAuth ? currentAuthColumns : policy.columnsHash)
    ) {
      throw new HistorySchemaRefused({ reason: "column-definition-mismatch", table: policy.name });
    }
  }
  const migrations = Schema.decodeUnknownSync(migrationSchema)(
    database
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all(),
  );
  if (
    hash(JSON.stringify(migrations.map((m) => [m.migration_id, m.name]))) !==
    (target === "source" && !currentAuthLayout ? legacySourceMigrationHash : expectedMigrationHash)
  ) {
    throw new HistorySchemaRefused({ reason: "migration-ledger-mismatch" });
  }
  const indexes = Schema.decodeUnknownSync(tableSchema)(
    database
      .prepare(
        "SELECT m.name, m.sql FROM sqlite_master m JOIN pragma_index_list(m.tbl_name) i ON m.name=i.name WHERE m.type='index' AND i.[unique]=1 AND m.sql IS NOT NULL ORDER BY m.name",
      )
      .all(),
  );
  if (
    hash(
      JSON.stringify(indexes.map((index) => [index.name, index.sql.replace(/\s+/g, " ").trim()])),
    ) !== expectedUniqueIndexes
  ) {
    throw new HistorySchemaRefused({ reason: "unique-index-mismatch" });
  }
  const version = database.prepare("PRAGMA user_version").get();
  if (version?.user_version !== 0)
    throw new HistorySchemaRefused({ reason: "user-version-mismatch" });
  const unsafeObjects = database
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view')")
    .all();
  if (unsafeObjects.length !== 0)
    throw new HistorySchemaRefused({ reason: "unexpected-trigger-or-view" });
  return hash(
    JSON.stringify({
      tables: historyTables,
      currentAuthDefinition,
      currentAuthColumns,
      expectedMigrationHash,
      legacySourceMigrationHash,
      expectedUniqueIndexes,
      userVersion: 0,
    }),
  );
}

export const assertSourceHistorySchema = (database: NodeSqlite.DatabaseSync) =>
  assertSchema(database, "source");
export const assertDestinationHistorySchema = (database: NodeSqlite.DatabaseSync) =>
  assertSchema(database, "destination");
