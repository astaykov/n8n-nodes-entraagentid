# Microsoft Entra Agent ID — Setup Guide (Preview)
> Uses `Microsoft.Entra.Beta` v1.2.0+ native cmdlets. Requires PowerShell 7.

## 0. Install & Connect
You must install both `Microsoft.Entra` and `Microsoft.Entra.Beta` modules, if you have not already.

```powershell
Install-Module -Name Microsoft.Entra -RequiredVersion 1.2.0 -Repository PSGallery -Force -AllowClobber
Install-Module -Name Microsoft.Entra.Beta -RequiredVersion 1.2.0 -Repository PSGallery -Force -AllowClobber

Connect-Entra -Scopes "Organization.Read.All",
                       "AgentIdentityBlueprint.ReadWrite.All",
                       "AgentIdentityBlueprintPrincipal.ReadWrite.All",
                       "AgentIdentity.ReadWrite.All",
                       "AgentIdUser.ReadWrite.All" `
              -TenantId "<your-tenant-id>"
```

---

## 1. Run the `Invoke-EntraBetaAgentIdInteractive`

For the goal of demo purposes in is best to use `Global Administrator` role. 

```powershell
Invoke-EntraBetaAgentIdInteractive
```
This example starts the interactive Agent Identity configuration workflow. The cmdlet will prompt you for all required inputs and guide you through the complete setup process.
At the end of the execution, you will have all required parameters to fill in the n8n Entra Agent ID Credentials API.

You must provide at least:
* Agent Identity Blueprint name
* Provide scope for interactive agents scenarios
* Create one Agent Identity
* Create one Agent User

This short video walks over the process with demo values provided:
[![Watch the Agent Identity setup process](./media/CreateAgentBlueprint.mp4)](./media/CreateAgentBlueprint.mp4)


> **Note:** take a note of the user principal name prefix you give for the agent user, you will need it for the `On Behalf Of (optional) - either a UPN of Agent User, or an incoming bearer token for OBO flow` configuration in n8n. There you must provide the UPN of Agent ID User created. You will be asked to provide it in `Enter UPN prefix for this Agent User (will be @<tenant.default.domain>:` step. 

## 2. Collect the resulted artefacts

The result of the operation will be similar to this one:

```powershell
=== Agent Identity and User Creation Summary ===
Total Agent Identities created: 1
Total Agent Users created: 1

=== Complete Workflow Summary ===
✓ 1. Agent Identity Blueprint created and configured
✓ 2. Client secret added for API authentication
✓ 3. Interactive agent scopes configured with user prompts
- 4. Inheritable permissions (skipped by user choice)
✓ 5. Service Principal created with proper permissions
✓ 6. Agent user creation permissions granted
- 7. Admin consent flow (skipped - no inheritable permissions)
✓ 8-9. Agent Identity and User Creation completed
    - Created 1 Agent Identity
    - Created 1 Agent User

Module state:
Current Blueprint ID: <copy this value for 'Blueprint ID (client_id of the Agent Identity Blueprint)'>
Current Blueprint App ID: <this is same as above>
Current Service Principal ID: <this is not required for the configuration>
Total Agent Identities created: 1
Total Agent Users created: 1
Last Agent Identity ID: <copy this value for 'Agent ID (object id of the Agent Identity)'>
Last Agent User ID: <this is not required for the configuration>
Secret stored: Yes
Has inheritable permissions: No
Has Agent ID users: Yes
```
Finally, you will need to add a new client secret to the Agent Identity Blueprint for your n8n configuration:

```powershell
 Add-EntraBetaClientSecretToAgentIdentityBlueprint -AgentBlueprintId <the Blueprint ID value from previous step>
```
> **Note:** copy the value of `secretText` and use it for the `Blueprint Secret (client_secret of Agent Identity Blueprint)` in n8n. You will never see this secret text again.

---


## 3. (Optional) Assign Agent User to Global Reader Role

```powershell
$globalReaderRole = Get-EntraBetaDirectoryRole | Where-Object DisplayName -eq "Global Reader"

Add-EntraBetaDirectoryRoleMember `
  -ObjectId    $globalReaderRole.Id `
  -RefObjectId $agentUserId
```
