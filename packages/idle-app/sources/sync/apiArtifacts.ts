import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';
import { getIdleClientId } from './apiSocket';
import {
    Artifact,
    ArtifactCreateRequest,
    ArtifactCreateRequestSchema,
    ArtifactFullResponseSchema,
    ArtifactIdSchema,
    ArtifactListResponseSchema,
    ArtifactUpdateRequest,
    ArtifactUpdateRequestSchema,
    ArtifactUpdateResponse,
    ArtifactUpdateResponseSchema,
} from './artifactTypes';
import { readBoundedJsonResponse } from './boundedJsonResponse';
import { streamingFetch } from './streamingFetch';

const MAX_ARTIFACT_LIST_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_ARTIFACT_RESPONSE_BYTES = 256 * 1024;

/**
 * Fetch all artifacts for the account
 */
export async function fetchArtifacts(credentials: AuthCredentials): Promise<Artifact[]> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/artifacts`, {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch artifacts: ${response.status}`);
        }

        const data = ArtifactListResponseSchema.parse(await readBoundedJsonResponse(
            response,
            MAX_ARTIFACT_LIST_RESPONSE_BYTES,
        ));
        return data;
    });
}

/**
 * Fetch a single artifact with full body
 */
export async function fetchArtifact(credentials: AuthCredentials, artifactId: string): Promise<Artifact> {
    const API_ENDPOINT = getServerUrl();
    const validatedArtifactId = ArtifactIdSchema.parse(artifactId);

    return await backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/artifacts/${encodeURIComponent(validatedArtifactId)}`, {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Artifact not found');
            }
            throw new Error(`Failed to fetch artifact: ${response.status}`);
        }

        const data = ArtifactFullResponseSchema.parse(await readBoundedJsonResponse(
            response,
            MAX_ARTIFACT_RESPONSE_BYTES,
        ));
        return data;
    });
}

/**
 * Create a new artifact
 */
export async function createArtifact(
    credentials: AuthCredentials,
    request: ArtifactCreateRequest
): Promise<Artifact> {
    const API_ENDPOINT = getServerUrl();
    const validatedRequest = ArtifactCreateRequestSchema.parse(request);

    return await backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/artifacts`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            },
            body: JSON.stringify(validatedRequest)
        });

        if (!response.ok) {
            if (response.status === 409) {
                throw new Error('Artifact ID already exists');
            }
            throw new Error(`Failed to create artifact: ${response.status}`);
        }

        const data = ArtifactFullResponseSchema.parse(await readBoundedJsonResponse(
            response,
            MAX_ARTIFACT_RESPONSE_BYTES,
        ));
        return data;
    });
}

/**
 * Update an existing artifact
 */
export async function updateArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    request: ArtifactUpdateRequest
): Promise<ArtifactUpdateResponse> {
    const API_ENDPOINT = getServerUrl();
    const validatedArtifactId = ArtifactIdSchema.parse(artifactId);
    const validatedRequest = ArtifactUpdateRequestSchema.parse(request);

    return await backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/artifacts/${encodeURIComponent(validatedArtifactId)}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            },
            body: JSON.stringify(validatedRequest)
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Artifact not found');
            }
            throw new Error(`Failed to update artifact: ${response.status}`);
        }

        const data = ArtifactUpdateResponseSchema.parse(await readBoundedJsonResponse(
            response,
            MAX_ARTIFACT_RESPONSE_BYTES,
        ));
        return data;
    });
}

/**
 * Delete an artifact
 */
export async function deleteArtifact(
    credentials: AuthCredentials,
    artifactId: string
): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    const validatedArtifactId = ArtifactIdSchema.parse(artifactId);

    return await backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/artifacts/${encodeURIComponent(validatedArtifactId)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('Artifact not found');
            }
            throw new Error(`Failed to delete artifact: ${response.status}`);
        }
    });
}
