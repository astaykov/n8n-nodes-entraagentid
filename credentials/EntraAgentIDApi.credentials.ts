import type {
	Icon,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';
import {
	fetchBlueprintFic,
	fetchAgentFic,
	fetchUserFic,
	fetchUserOboToken,
	DEFAULT_SCOPE,
	getNormalizedOnBehalfOf,
	resolveUserScope,
	validateTokenEndpoint,
} from '../nodes/shared/agentIdTokenForms';

export class EntraAgentIDApi implements ICredentialType {
	name = 'entraAgentIDApi';

	displayName = 'Microsoft Entra Agent ID (Blueprint) Credentials API';

	icon: Icon = 'file:../icons/agentid-credentials.svg';

	documentationUrl = 'https://github.com/astaykov/n8n-nodes-entraagentid/blob/main/README.md';

	properties: INodeProperties[] = [
		{
			displayName: 'Entra ID Token Endpoint',
			name: 'entraIdTokenEndpoint',
			type: 'string',
			default: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
			required: true,
			description: 'Your Entra ID token endpoint URL',
		},
		{
			displayName: 'Blueprint ID (client_id of the Agent Identity Blueprint)',
			name: 'blueprintId',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Blueprint Secret (client_secret of Agent Identity Blueprint)',
			name: 'blueprintSecret',
			type: 'string',
			default: '',
			required: true,
			typeOptions: {
				password: true,
			},
		},
		{
			displayName: 'Agent ID (object id of the Agent Identity)',
			name: 'agentId',
			type: 'string',
			default: '',
			required: true,
			description: 'This is the object id of the Agent Identity',
		},
		{
			displayName: 'On Behalf Of (optional) - either a UPN of Agent User, or an incoming bearer token for OBO flow',
			name: 'onBehalfOf',
			type: 'string',
			default: '',
			required: false,
			description: 'Request authorization on behalf of user (Agent User or incoming bearer token for end-user authorization)',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'string',
			default: 'https://graph.microsoft.com/.default',
			required: true,
			description: 'Provide the scope for the requested resource access.',
		},
	];

	authenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const tokenEndpoint = credentials.entraIdTokenEndpoint as string;
		validateTokenEndpoint(tokenEndpoint);
		const blueprintId = credentials.blueprintId as string;
		const blueprintSecret = credentials.blueprintSecret as string;
		const agentId = credentials.agentId as string;
		const userScope = resolveUserScope(credentials.scope as string | undefined);
		const onBehalfOf = getNormalizedOnBehalfOf(credentials.onBehalfOf as string | undefined);

		// 1) Blueprint FIC
		const blueprintFicRes = await fetchBlueprintFic(tokenEndpoint, blueprintId, blueprintSecret, agentId);
		if (!blueprintFicRes.access_token) {
			throw new Error('[Blueprint FIC] Token response missing access_token');
		}
		const blueprintFic = blueprintFicRes.access_token;

		// 2) AgentID FIC
		const agentidFicRes = await fetchAgentFic(tokenEndpoint, agentId, blueprintFic, userScope, onBehalfOf !== undefined);
		if (!agentidFicRes.access_token) {
			throw new Error('[AgentID FIC] Token response missing access_token');
		}
		const agentidFic = agentidFicRes.access_token;

		let accessToken: string;

		if (onBehalfOf === undefined) {
			accessToken = agentidFic;
		} else if (/^bearer\s/i.test(onBehalfOf)) {
			const rawUserToken = onBehalfOf.replace(/^bearer\s+/i, '').trim();
			if (rawUserToken.length === 0) {
				throw new Error('[User Token] Invalid onBehalfOf value: bearer token is empty');
			}
			const oboRes = await fetchUserOboToken(tokenEndpoint, agentId, blueprintFic, rawUserToken, userScope);
			if (!oboRes.access_token) {
				throw new Error('[User Token (OBO)] Token response missing access_token');
			}
			accessToken = oboRes.access_token;
		} else {
			const userFicRes = await fetchUserFic(tokenEndpoint, agentId, blueprintFic, agentidFic, onBehalfOf, userScope);
			if (!userFicRes.access_token) {
				throw new Error('[User Token (Agent User)] Token response missing access_token');
			}
			accessToken = userFicRes.access_token;
		}

		// Inject the Authorization header into the outgoing request
		if (!requestOptions.headers) {
			requestOptions.headers = {};
		}
		requestOptions.headers.Authorization = `Bearer ${accessToken}`;

		return requestOptions;
	};

	test: ICredentialTestRequest = {
		request: {
			method: 'POST' as const,
			url: '={{$credentials.entraIdTokenEndpoint}}',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: '={{"grant_type=client_credentials" + "&client_id=" + encodeURIComponent($credentials.blueprintId) + "&client_secret=" + encodeURIComponent($credentials.blueprintSecret) + "&scope=" + encodeURIComponent("' + DEFAULT_SCOPE + '") + "&fmi_path=" + encodeURIComponent($credentials.agentId)}}',
		},
	};
}