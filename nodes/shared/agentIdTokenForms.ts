export interface TokenSet {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    [key: string]: unknown;
}

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const OBO_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
export const DEFAULT_SCOPE = 'api://AzureADTokenExchange/.default';

export const getNormalizedOnBehalfOf = (onBehalfOf: string | undefined): string | undefined => {
    if (typeof onBehalfOf !== 'string') {
        return undefined;
    }
    const normalized = onBehalfOf.trim();
    return normalized.length > 0 ? normalized : undefined;
};

export const resolveUserScope = (scope: string | undefined): string => scope || DEFAULT_SCOPE;

export const validateTokenEndpoint = (tokenEndpoint: string): void => {
    const parsed = new URL(tokenEndpoint);
    if (parsed.protocol !== 'https:') {
        throw new Error(`Token endpoint must use HTTPS (received: ${tokenEndpoint})`);
    }
};

// Sends a URL-encoded POST to the token endpoint and returns the parsed JSON
// response as a TokenSet. OAuth error fields (error / error_description) are
// formatted into the thrown Error message so callers get a readable string.
async function postTokenRequest(
    tokenEndpoint: string,
    params: Record<string, string>,
): Promise<TokenSet> {
    const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    });
    const text = await response.text();
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new Error(
            `Token endpoint returned non-JSON response (${response.status}): ${text.slice(0, 200)}`,
        );
    }
    if (!response.ok) {
        const error = typeof data.error === 'string' ? data.error : String(response.status);
        const desc =
            typeof data.error_description === 'string' ? ': ' + data.error_description : '';
        throw new Error(`${error}${desc}`);
    }
    return data as TokenSet;
}

/**
 * Step 1 – Blueprint FIC
 * Standard client_credentials + custom fmi_path body param to indicate the actual Agent Identity.
 */
export const fetchBlueprintFic = (
    tokenEndpoint: string,
    blueprintId: string,
    blueprintSecret: string,
    agentId: string,
): Promise<TokenSet> =>
    postTokenRequest(tokenEndpoint, {
        grant_type: 'client_credentials',
        scope: DEFAULT_SCOPE,
        fmi_path: agentId,
        client_id: blueprintId,
        client_secret: blueprintSecret,
    });

/**
 * Step 2 – AgentID FIC
 * client_credentials with client_assertion (blueprint fic from step 1)
 */
export const fetchAgentFic = (
    tokenEndpoint: string,
    agentId: string,
    blueprintFic: string,
    scope: string,
    hasOnBehalfOf: boolean,
): Promise<TokenSet> => {
    const resolvedScope = hasOnBehalfOf ? DEFAULT_SCOPE : scope;
    return postTokenRequest(tokenEndpoint, {
        grant_type: 'client_credentials',
        scope: resolvedScope,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: blueprintFic,
        client_id: agentId,
    });
};

/**
 * Step 3a – Agent User access token
 * using grant_type=user_fic with client_assertion (blueprint fic)
 * and user_federated_identity_credential (AgentID fic).
 */
export const fetchUserFic = (
    tokenEndpoint: string,
    agentId: string,
    blueprintFic: string,
    agentidFic: string,
    username: string,
    scope: string,
): Promise<TokenSet> =>
    postTokenRequest(tokenEndpoint, {
        grant_type: 'user_fic',
        requested_token_use: 'on_behalf_of',
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: blueprintFic,
        username,
        user_federated_identity_credential: agentidFic,
        scope,
        client_id: agentId,
    });

/**
 * Step 3b – on-behalf-of human user
 * client_assertion is still the blueprint fic
 * but the assertion for obo is the incoming bearer token.
 */
export const fetchUserOboToken = (
    tokenEndpoint: string,
    agentId: string,
    blueprintFic: string,
    userToken: string,
    scope: string,
): Promise<TokenSet> =>
    postTokenRequest(tokenEndpoint, {
        grant_type: OBO_GRANT_TYPE,
        assertion: userToken,
        requested_token_use: 'on_behalf_of',
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: blueprintFic,
        scope,
        client_id: agentId,
    });