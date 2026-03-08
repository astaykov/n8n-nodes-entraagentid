import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import {
	fetchBlueprintFic,
	fetchAgentFic,
	fetchUserFic,
	fetchUserOboToken,
	getNormalizedOnBehalfOf,
	resolveUserScope,
} from '../shared/agentIdTokenForms';
import { encryptToken, decryptToken, hashForCacheKey, extractJwtSubject } from '../shared/cryptoUtils';

/** Clock-skew safety margin subtracted from the actual token expiry. */
const SKEW_MS = 5 * 60 * 1000;

export class EntraAgentIdAuthManager implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Entra Agent ID Authentication Manager',
		name: 'entraAgentIdAuthManager',
		icon: 'file:../../icons/agentid-credentials.svg',
		group: ['transform'],
		version: 1,
		description: 'Manages token acquisition and caching for Entra Agent ID credentials',
		defaults: {
			name: 'Entra Agent ID Authentication Manager',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'entraAgentIDApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Get Token',
						value: 'getToken',
						description: 'Retrieve and cache an Agent ID access token',
						action: 'Retrieve and cache an agent id access token',
					},
				],
				default: 'getToken',
			},
			{
				displayName: 'Enable Token Cache',
				name: 'enableTokenCache',
				type: 'boolean',
				default: true,
				description: 'Whether to cache tokens. When disabled, cached tokens are wiped and fresh tokens are always fetched.',
				noDataExpression: true,
			},
		],
		usableAsTool: true,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = await this.getCredentials('entraAgentIDApi');
		const staticData = this.getWorkflowStaticData('node');
		const enableTokenCache = this.getNodeParameter('enableTokenCache', 0, true) as boolean;
		const blueprintSecret = credentials.blueprintSecret as string;

		// Resolve onBehalfOf early — required for cache-key computation before the cache check.
		const onBehalfOf = getNormalizedOnBehalfOf(credentials.onBehalfOf as string | undefined);

		// Derive a privacy-preserving cache key.
		// • No onBehalfOf → null (use the global single-slot cache).
		// • Bearer token  → SHA-256 of the JWT `sub` claim or the whole token if decoding fails.
		// • anything else → SHA-256 of the string.
		let userCacheKey: string | null = null;
		if (onBehalfOf) {
			if (/^bearer\s/i.test(onBehalfOf)) {
				const rawToken = onBehalfOf.replace(/^bearer\s+/i, '').trim();
				const sub = extractJwtSubject(rawToken);
				userCacheKey = hashForCacheKey(sub ?? rawToken);
			} else {
				userCacheKey = hashForCacheKey(onBehalfOf);
			}
		}

		const now = Date.now();

		if (!enableTokenCache) {
			delete staticData.accessToken;
			delete staticData.expiry;
			delete staticData.userTokenCache;
		}

		// Accessor for the per-user token cache map (lazily initialised).
		const getUserCache = (): Record<string, { accessToken: string; expiry: number }> => {
			if (!staticData.userTokenCache || typeof staticData.userTokenCache !== 'object') {
				staticData.userTokenCache = {};
			}
			return staticData.userTokenCache as Record<string, { accessToken: string; expiry: number }>;
		};

		let finalToken!: string;
		let expiresIn!: number;
		let cached = false;

		// ── Cache read ────────────────────────────────────────────────────────────
		if (enableTokenCache) {
			if (userCacheKey === null) {
				// Global (no-OBO) cache slot
				if (
					staticData.accessToken &&
					typeof staticData.expiry === 'number' &&
					staticData.expiry > now
				) {
					try {
						finalToken = decryptToken(staticData.accessToken as string, blueprintSecret);
						expiresIn = Math.floor(((staticData.expiry as number) - now) / 1000);
						cached = true;
					} catch {
						// Decryption failed (rotated secret / corrupted data) — treat as cache miss.
						delete staticData.accessToken;
						delete staticData.expiry;
					}
				}
			} else {
				// Per-user cache slot
				const userCache = getUserCache();
				const entry = userCache[userCacheKey];
				if (entry && typeof entry.expiry === 'number' && entry.expiry > now) {
					try {
						finalToken = decryptToken(entry.accessToken, blueprintSecret);
						expiresIn = Math.floor((entry.expiry - now) / 1000);
						cached = true;
					} catch {
						// Corrupted or stale entry — evict and fall through to a fresh fetch.
						delete userCache[userCacheKey];
					}
				}
			}
		}

		// ── Token acquisition (cache miss) ────────────────────────────────────────
		if (!cached) {
			const tokenEndpoint = credentials.entraIdTokenEndpoint as string;
			const blueprintId = credentials.blueprintId as string;
			const agentId = credentials.agentId as string;
			const userScope = resolveUserScope(credentials.scope as string | undefined);

			// Step 1: Blueprint FIC
			const blueprintFicRes = await fetchBlueprintFic(tokenEndpoint, blueprintId, blueprintSecret, agentId);
			const blueprintFic = blueprintFicRes.access_token!;

			// Step 2: AgentID FIC
			const agentidFicRes = await fetchAgentFic(tokenEndpoint, agentId, blueprintFic, userScope, !!onBehalfOf);
			const agentidFic = agentidFicRes.access_token!;

			expiresIn = 3600;

			// Step 3: Final Token
			if (!onBehalfOf) {
				finalToken = agentidFic;
				expiresIn = Number(agentidFicRes.expires_in) || 3600;
			} else if (/^bearer\s/i.test(onBehalfOf)) {
				const rawToken = onBehalfOf.replace(/^bearer\s+/i, '').trim();
				const res = await fetchUserOboToken(tokenEndpoint, agentId, blueprintFic, rawToken, userScope);
				finalToken = res.access_token!;
				expiresIn = Number(res.expires_in) || 3600;
			} else {
				const res = await fetchUserFic(tokenEndpoint, agentId, blueprintFic, agentidFic, onBehalfOf, userScope);
				finalToken = res.access_token!;
				expiresIn = Number(res.expires_in) || 3600;
			}

			const expiry = now + expiresIn * 1000 - SKEW_MS;

			// ── Cache write ───────────────────────────────────────────────────────
			if (enableTokenCache) {
				if (userCacheKey === null) {
					staticData.accessToken = encryptToken(finalToken, blueprintSecret);
					staticData.expiry = expiry;
				} else {
					const userCache = getUserCache();
					userCache[userCacheKey] = {
						accessToken: encryptToken(finalToken, blueprintSecret),
						expiry,
					};
				}
			}
		}

		// Pass through all input items, enriched with token data.
		const outputItems: INodeExecutionData[] = items.map((item, index) => ({
			json: {
				...item.json,
				agent_id_access_token: finalToken,
				cached,
				expires_in: expiresIn,
			},
			binary: item.binary,
			pairedItem: { item: index },
		}));

		// If there were no input items, emit a single item with just the token.
		if (outputItems.length === 0) {
			outputItems.push({ json: { agent_id_access_token: finalToken, cached, expires_in: expiresIn } });
		}

		return [outputItems];
	}
}