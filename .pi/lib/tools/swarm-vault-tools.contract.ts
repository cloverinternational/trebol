/** Model-facing contracts for the tools registered by this module. */
import type { ToolContract } from "../runtime/tool-contract.ts";

export const VAULT_CONTRACT: ToolContract = {
  description: "Manage stored connection and authentication entries for autonomous work. Use action=list with optional query, kind, scope, or tags to find an entry, action=get to retrieve one, action=add to store one, and action=remove to delete one. The transparent vault returns retrieved secrets in plaintext; use them only for the current task and never echo, quote, log, commit, or expose them. Use action=remove only when requested.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "list", "get", "remove"], description: "Use get for one credential, list to discover available credentials, add to store a credential, or remove to delete one." },
      id: { type: "string", description: "Credential identifier. Required for get and remove; use the id returned by list." },
      kind: { type: "string", description: "Credential kind, such as password, api_key, or ssh_key." },
      query: { type: "string", description: "Optional case-insensitive search across credential id, name, and kind. Prefer query/list before asking the user to provide a credential." },
      scope: { type: "string", description: "Optional credential scope filter." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags that every result must contain." },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      cursor: { type: "string", description: "Cursor returned by a previous list operation." },
      details: { type: "boolean", default: false, description: "Include nonessential metadata such as tags and allowed hosts." },
      secret: { type: "string", description: "Credential value to store. The vault is transparent and returns secrets in plaintext for get; never echo, log, commit, or expose retrieved secrets." },
      name: { type: "string" },
      target: { type: "string", description: "Optional environment variable or file target associated with this entry." },
    },
    required: ["action"],
  },
};

export const VAULT_ADD_CONTRACT: ToolContract = {
  description: "Add a new credential to the shared vault.\n\nThe vault is a shared local credential store. Once unlocked, all agents and\nTUI sessions on this machine can use the same credentials freely.\n\nStore credentials whenever the user provides one or you discover one during a\nsession. The credential is available immediately for use with vault_exec.\n\nExample:\n  vault_add {id: \"github-token\", kind: \"bearer_token\", secret: \"ghp_...\", target: \"GITHUB_TOKEN\"}\n  -> {success: true, credentialId: \"github-token\"}\n\nTo change ONLY allowedTools/allowedCommands/allowedHosts/tags/target on an EXISTING\ncredential without touching its stored secret (the vault never returns a secret to you,\nso there is no other safe way to re-supply it), omit 'secret' entirely:\n  vault_add {id: \"github-token\", allowedCommands: [\"gh *\"]}\n  -> {success: true, credentialId: \"github-token\", metadataOnly: true}\nA 'secret' that IS supplied for kind=ssh_key is validated as PEM/OpenSSH key material and\nrejected with an explicit error if it is not -- it is never silently accepted or discarded.\n\nSet unlockIfNeeded:true if the vault might be locked.",
  parameters: {"properties":{"allowedCommands":{"description":"Command patterns allowed (e.g., ['aws *', 'git clone *'])","items":{"type":"string"},"type":"array"},"allowedHosts":{"description":"Host patterns allowed (e.g., ['github.com', '*.amazonaws.com'])","items":{"type":"string"},"type":"array"},"allowedTools":{"description":"Tools allowed to use this credential (e.g., ['bash', 'curl'])","items":{"type":"string"},"type":"array"},"expire":{"description":"Expiration duration: 24h, 7d, 30d, 90d, 1y","type":"string"},"id":{"description":"Unique ID for the credential (e.g., 'github-token', 'aws-prod')","type":"string"},"kind":{"description":"Credential kind: api_key, bearer_token, ssh_key, aws_access_key, aws_secret_key, password, env_var","type":"string"},"name":{"description":"Human-readable name","type":"string"},"scope":{"description":"Scope: global (default) or project","type":"string"},"secret":{"description":"The secret value to store (encrypted at rest in the age vault, or base64-obfuscated (NOT encrypted) in a transparent vault). Omit to update ACL/metadata fields on an EXISTING credential id without touching its stored secret.","type":"string"},"tags":{"description":"Tags for filtering (e.g., ['sensitive', 'production', 'ci'])","items":{"type":"string"},"type":"array"},"target":{"description":"Env var name or file path for injection (e.g., 'GITHUB_TOKEN', '/tmp/ssh-key')","type":"string"},"threshold":{"description":"If >=2, store as two-person (N-of-M): this many distinct approvers required to use it. Requires a team roster.","type":"integer"},"unlockIfNeeded":{"description":"If true, ask the host to unlock a locked vault; TUI support is optional and headless hosts return immediately","type":"boolean"}},"required":["id","kind"],"type":"object"},
};

export const VAULT_APPROVE_CONTRACT: ToolContract = {
  description: "Approve a pending two-person credential request. Set unlockIfNeeded when the vault may be locked.",
  parameters: {"properties":{"identityPath":{"description":"Path to the approver's age identity file (defaults to the configured user identity)","type":"string"},"requestId":{"description":"Two-person request id to approve (from a needs_two_person response)","type":"string"},"unlockIfNeeded":{"description":"If true, ask the host to unlock a locked vault; TUI support is optional and headless hosts return immediately","type":"boolean"}},"required":["requestId"],"type":"object"},
};

export const VAULT_EXEC_CONTRACT: ToolContract = {
  description: "Execute a command with a stored credential injected into its environment. Find credential IDs with vault_list; set unlockIfNeeded when the vault may be locked.",
  parameters: {"properties":{"approvalId":{"description":"Approval ID from a prior needs_approval response, to retry after the user approves","type":"string"},"args":{"description":"Command arguments","items":{"type":"string"},"type":"array"},"command":{"description":"Command to execute with the credential","type":"string"},"credentialId":{"description":"ID of the credential to use (list with vault_list)","type":"string"},"host":{"description":"Target host (auto-extracted from command if not provided)","type":"string"},"reason":{"description":"Why this credential is needed (for approval prompts)","type":"string"},"timeout":{"description":"Timeout in seconds (default 60)","type":"integer"},"twoPersonRequestId":{"description":"Request ID from a prior needs_two_person response, to finalize+run after a second person has approved via vault_approve","type":"string"},"unlockIfNeeded":{"description":"If true, ask the host to unlock a locked vault; TUI support is optional and headless hosts return immediately","type":"boolean"},"workingDir":{"description":"Working directory for command execution","type":"string"}},"required":["credentialId","command"],"type":"object"},
};

export const VAULT_LIST_CONTRACT: ToolContract = {
  description: "List stored credential metadata for use with vault_exec. Set unlockIfNeeded when the vault may be locked.",
  parameters: {"properties":{"kind":{"description":"Filter by credential kind","type":"string"},"scope":{"description":"Filter by scope: global or project","type":"string"},"tags":{"description":"Filter by tags (credential must have all specified tags)","items":{"type":"string"},"type":"array"},"unlockIfNeeded":{"description":"If true, ask the host to unlock a locked vault; TUI support is optional and headless hosts return immediately","type":"boolean"}},"type":"object"},
};

export const VAULT_TWO_PERSON_STATUS_CONTRACT: ToolContract = {
  description: "Check a pending two-person credential request. Set unlockIfNeeded when the vault may be locked.",
  parameters: {"properties":{"requestId":{"description":"Two-person request id to inspect (from a needs_two_person response)","type":"string"},"unlockIfNeeded":{"description":"If true, ask the host to unlock a locked vault; TUI support is optional and headless hosts return immediately","type":"boolean"}},"required":["requestId"],"type":"object"},
};

export const CONTRACTS: Record<string, ToolContract> = {
  vault: VAULT_CONTRACT,
  vault_add: VAULT_ADD_CONTRACT,
  vault_approve: VAULT_APPROVE_CONTRACT,
  vault_exec: VAULT_EXEC_CONTRACT,
  vault_list: VAULT_LIST_CONTRACT,
  vault_two_person_status: VAULT_TWO_PERSON_STATUS_CONTRACT,
};
