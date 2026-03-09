# n8n-nodes-EntraAgentID

A custom [n8n](https://n8n.io/) credential that implements the [Microsoft Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/what-is-agent-id-platform) token exchange flows.

This credential implements Entra Agent ID token token acquisition and injects the resulting `access_token` as a Bearer header into any n8n HTTP node.

## Microsoft Entra Agent ID platform

Microsoft Entra Agent ID supports all three types of AI Agents: assistive agent acting on user's behalf (calssical on-behalf-of flow), autonomous agent acting with its own authorizations and agent user (digital employee). 

There are three main concepts in Microsoft Entra Agent ID: 
 - [Agent Identity Blueprint](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/agent-blueprint): An agent identity blueprint is an object in Microsoft Entra ID that serves as a template for creating agent identities. It establishes the foundation for how agents are created, authenticated, and managed within an organization.
 - [Agent Identities](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/agent-identities): An agent identity is a special service principal in Microsoft Entra ID. It represents an identity that the agent identity blueprint created and is authorized to impersonate. It doesn't have credentials on its own. The agent identity blueprint can acquire tokens on behalf of the agent identity provided the user or tenant admin consented for the agent identity to the corresponding scopes. Autonomous agents acquire app tokens on behalf of the agent identity. Interactive agents called with a user token acquire user tokens on behalf of the agent identity.
 - [Agent User](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/agent-users): Agent users are a specialized identity type designed to bridge the gap between agents and human user capabilities. Agent users enable AI-powered applications to interact with systems and services that require user identities, while maintaining appropriate security boundaries and management controls. It allows organizations to manage those agent's access using similar capabilities as they do for human users. 

> **Note** You must create all the neccessary artefacts and grant consents (authorizations) in Microsoft Entra ID first. You can follow
> the instructions to create [agent identity blueprint](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/create-blueprint?tabs=powershell) and [agent identities](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/create-delete-agent-identities?tabs=microsoft-graph-api)

## Package Components

This package ships two complementary components that together cover the full range of Entra Agent ID token acquisition scenarios.

---

### EntraAgentID Credential

`Microsoft Entra Agent ID (Blueprint) credentials` is an n8n credential type. It stores all configuration needed to authenticate as an Agent Identity and prepares a ready-to-use `Bearer` token for use in `Authorization` header of any n8n node.

While this node implements the `authenticate` hook, **the credential always fetches a fresh token** and does not implement any caching. For workflows that make many downstream calls this can add perceptible latency and consume unnecessary Entra ID token-endpoint quota. That is why the [Authentication Manager node](#entra-agent-id-authentication-manager) is the recommended approach for production workflows.

#### Credential Fields

| Field | Description |
|---|---|
| **Entra ID Token Endpoint** | Your Entra ID token endpoint, e.g. `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`. The `common` and `organizations` endpoints are **not** supported with Entra Agent ID — you must supply a tenant-specific URL. |
| **Blueprint ID** | The `Application (client) ID` of the Agent Identity Blueprint app registration. |
| **Blueprint Secret** | The `client_secret` of the Agent Identity Blueprint. Stored encrypted by n8n. |
| **Agent ID** | The **object ID** of the Agent Identity (service principal) to authenticate. |
| **On Behalf Of** *(optional)* | Determines the token flow: leave empty for an **autonomous agent** token (app-only). Supply a UPN (e.g. `agent@contoso.com`) to acquire a token on behalf of an **Agent User**. Supply `Bearer <token>` to perform a standard **OBO flow** on behalf of a signed-in human user. |
| **Scope** | The target resource scope, e.g. `https://graph.microsoft.com/.default`. Defaults to `https://graph.microsoft.com/.default`. |

> **Note:** For instructions on how to create agent identity blueprint, agent identity, agent user and add secret to the blueprint, follow the instructions [here](./readme.entra.agentid.md).

### Entra Agent ID Authentication Manager

`Entra Agent ID Authentication Manager` is an n8n **node** (trigger/transform) that sits inside your workflow and explicitly manages token acquisition and caching. It outputs the acquired `access_token` (and metadata) as fields on every item passing through it, so subsequent nodes in your workflow can reference `{{ $json.agent_id_access_token }}` directly.

It implements a simple token caching using the static workflow data. Access tokens are encrypted before writing to the cache. Caching layer accounts for the variances of the flows - `agent user` vs `autonomous agent` vs `on-behalf-of` end user.

#### Why use the Manager instead of the Credential?

| Concern | Credential only | With Manager node |
|---|---|---|
| Token reuse across calls within the same workflow | No — fresh token per request | Yes — cached and reused until near-expiry |
| Entra ID token-endpoint calls per workflow run | One per HTTP Request node | One per workflow run (on cache miss) |
| Explicit control over caching | Not available | Enable/disable via node property |
| Token visible to subsequent nodes | No | Yes — `agent_id_access_token` on the item |
| Suitable for high-throughput workflows | Limited | Recommended |

For any workflow that calls the same protected resource more than once, or that runs frequently, **we recommend placing the Authentication Manager node at the start of your workflow** and using its output token in all downstream HTTP Request nodes via an expression. This minimizes round-trips to the Entra ID token endpoint and keeps your workflow fast.

#### Token Caching Logic

The manager uses n8n **workflow static data** for the cache, which persists across executions within the same running workflow instance.

- **Cache key isolation** — the cache is split into two tiers:
  - *Global slot* — used when **On Behalf Of** is empty (autonomous agent). A single encrypted token entry is stored.
  - *Per-user slot* — used when **On Behalf Of** is set. Each user identity gets its own slot, keyed by the **SHA-256 hash** of the identity value. For incoming `Bearer` tokens the key is the SHA-256 of the JWT `sub` claim (or the full token string if decoding fails), so raw PII is never written to cache.

- **Encrypted at rest** — cached tokens are encrypted with **AES-256-GCM** using a key derived from the Blueprint Secret via `scrypt`. The Blueprint Secret itself is never stored in the cache. If the secret is rotated, decryption fails gracefully and a fresh token is fetched automatically.

- **Expiry with clock-skew buffer** — cached tokens are considered expired **5 minutes before** their actual `expires_in` deadline. This prevents edge cases where a token is valid when read from cache but expired by the time it reaches the downstream service.

- **Disabling the cache** — when **Enable Token Cache** is set to `false`, all existing cached entries (global and per-user) are wiped at the start of execution, and a fresh token is always fetched. This is useful during development or when you need guaranteed token freshness.

#### Output Fields

Each item emitted by the manager carries the following additional JSON fields:

| Field | Type | Description |
|---|---|---|
| `agent_id_access_token` | `string` | The acquired (or cached) Bearer access token. |
| `cached` | `boolean` | `true` if the token was served from cache, `false` if freshly fetched. |
| `expires_in` | `number` | Remaining token lifetime in seconds at the time of acquisition. |

#### Authentication Manager Node Properties

| Property | Description |
|---|---|
| **Credential** | Select an **EntraAgentID** credential (required). All token endpoint, blueprint, and agent settings are read from there. |
| **Operation** | Currently only `Get Token` is available. |
| **Enable Token Cache** | Toggle in-memory token caching. When disabled, cached tokens are wiped and a fresh token is always fetched. Defaults to `true`. |

## Installation

### From npm (community nodes)

1. Open your n8n instance.
2. Go to **Settings → Community Nodes**.
3. Enter `@astaykov/n8n-nodes-EntraAgentID` and click **Install**.

See the [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/installation/) for details.

### Manual installation

```bash
cd ~/.n8n/nodes
npm install @astaykov/n8n-nodes-EntraAgentID
```

Restart n8n after installation.

## Usage

### Recommended: Using the Authentication Manager node

1. Create a credential of type **Microsoft Entra Agent ID (Blueprint) credentials** and fill in all required fields (Token Endpoint, Blueprint ID, Blueprint Secret, Agent ID, and Scope).
2. Add an **Entra Agent ID Authentication Manager** node at the beginning of your workflow and select the credential you just created.
3. Enable **Token Cache** (default) to avoid redundant token fetches across executions.
4. In all downstream **HTTP Request** nodes, set the `Authorization` header to `Bearer {{ $('Entra Agent ID Authentication Manager').item.json.agent_id_access_token }}`.

### Simple: Using the Credential directly

1. Create a credential of type **Microsoft Entra Agent ID (Blueprint) credentials**.
2. Fill in the Token Endpoint, Blueprint ID, Blueprint Secret, Agent ID, and Scope.
3. *(Optional)* Set **On Behalf Of** to an agent user UPN or `Bearer <user-token>` for delegated access.
4. Attach this credential to any **HTTP Request** node — the Bearer token is injected automatically on every request.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Lint
npm run lint

# Watch mode (TypeScript only, no n8n validation)
npm run build:watch
```

## Resources

- [Microsoft Entra Agent ID Platform documentation](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/what-is-agent-id-platform)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Creating n8n community nodes](https://docs.n8n.io/integrations/creating-nodes/)
- [n8n credential documentation](https://docs.n8n.io/integrations/creating-nodes/build/reference/credentials-files/)

## License

[MIT](LICENSE)