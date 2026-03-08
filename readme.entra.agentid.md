# Microsoft Entra Agent ID — Setup Guide (Preview)
> Uses `Microsoft.Entra.Beta` v1.2.0+ native cmdlets. Requires PowerShell 7.

## 0. Install & Connect

```powershell
Install-Module -Name Microsoft.Entra.Beta -MinimumVersion 1.2.0 -Repository PSGallery -Force -AllowClobber

Connect-Entra -Scopes "AgentIdentityBlueprint.Create",
                       "AgentIdentityBlueprint.AddRemoveCreds.All",
                       "AgentIdentityBlueprint.ReadWrite.All",
                       "AgentIdentityBlueprintPrincipal.Create",
                       "AppRoleAssignment.ReadWrite.All",
                       "RoleManagement.ReadWrite.Directory",
                       "User.Read" `
              -TenantId "<your-tenant-id>"
```

---

## 1. Create Agent Identity Blueprint

```powershell
$blueprint = New-EntraBetaAgentIdentityBlueprint -DisplayName "n8n-agent-blueprint"

$blueprintAppId    = $blueprint.AppId
$blueprintObjectId = $blueprint.Id
Write-Host "Blueprint AppId: $blueprintAppId"
```

---

## 2. Add Client Secret

```powershell
Add-EntraBetaClientSecretToAgentIdentityBlueprint -BlueprintId $blueprintObjectId
# Outputs the secret — copy it immediately, it won't be shown again
```

---

## 3. Expose an API — App ID URI + Scope

```powershell
Add-EntraBetaScopeToAgentIdentityBlueprint `
  -BlueprintId      $blueprintObjectId `
  -ScopeValue       "access_agent" `
  -ScopeDisplayName "Access n8n agent" `
  -ScopeDescription "Allows access to the n8n agent"
```

---

## 4. Create Blueprint Principal

```powershell
$principal = New-EntraBetaAgentIdentityBlueprintPrincipal -AppId $blueprintAppId

$principalId = $principal.Id
Write-Host "Principal Id: $principalId"
```

---

## 5. Create Agent Identity

```powershell
$agent = New-EntraBetaAgentIdForAgentIdentityBlueprint `
  -BlueprintId $blueprintObjectId `
  -DisplayName "n8n-agent"

$agentId = $agent.Id
Write-Host "Agent Identity Id: $agentId"
```

---

## 6. Grant Admin Consent — Delegated Permissions

```powershell
Add-EntraBetaInheritablePermissionsToAgentIdentityBlueprint `
  -BlueprintId    $blueprintObjectId `
  -Permissions    @("Application.Read.All", "User.Read.All") `
  -PermissionType "Delegated" `
  -ConsentType    "AllPrincipals"
```

---

## 7. Grant Admin Consent — Application Permissions

```powershell
Add-EntraBetaInheritablePermissionsToAgentIdentityBlueprint `
  -BlueprintId    $blueprintObjectId `
  -Permissions    @("Application.Read.All", "User.Read.All") `
  -PermissionType "Application"
```

---

## 8. Create Agent User

```powershell
$agentUser = New-EntraBetaAgentIdUserForAgentId `
  -AgentIdentityId $agentId `
  -DisplayName     "n8n-agent-user"

$agentUserId = $agentUser.Id
Write-Host "Agent User Id: $agentUserId"
```

---

## 9. Assign Agent User to Global Reader Role

```powershell
$globalReaderRole = Get-EntraBetaDirectoryRole | Where-Object DisplayName -eq "Global Reader"

Add-EntraBetaDirectoryRoleMember `
  -ObjectId    $globalReaderRole.Id `
  -RefObjectId $agentUserId
```