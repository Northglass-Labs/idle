import * as z from 'zod';

//
// Schema
//

const SafeNonnegativeIntegerSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const BoundedNameSchema = z.string().max(256);
const BoundedUrlSchema = z.string().min(1).max(2_048).refine((value) => {
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:')
            && !url.username
            && !url.password
            && !!url.hostname;
    } catch {
        return false;
    }
}, 'Invalid image URL');
const GitHubAvatarUrlSchema = BoundedUrlSchema.refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:'
        && url.hostname === 'avatars.githubusercontent.com'
        && url.port === ''
        && url.hash === ''
        && /^\/u\/\d+(?:\/.*)?$/.test(url.pathname);
}, 'Untrusted GitHub avatar URL');
const AvatarPathSchema = z.string()
    .min(1)
    .max(2_048)
    .regex(/^public\/users\/[A-Za-z0-9_-]{1,64}\/avatars\/[A-Za-z0-9._-]{1,255}$/);

export const GitHubProfileSchema = z.object({
    id: SafeNonnegativeIntegerSchema,
    login: z.string().min(1).max(256),
    name: BoundedNameSchema.nullable(),
    avatar_url: GitHubAvatarUrlSchema,
    email: z.string().email().max(256).nullable().optional(),
    bio: z.string().max(8_192).nullable()
});

export const ImageRefSchema = z.object({
    width: z.number().finite().int().positive().max(100_000),
    height: z.number().finite().int().positive().max(100_000),
    thumbhash: z.string().min(1).max(1_024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    path: AvatarPathSchema,
    url: BoundedUrlSchema
});

export const ProfileSchema = z.object({
    id: z.string().max(64),
    timestamp: SafeNonnegativeIntegerSchema,
    firstName: BoundedNameSchema.nullable(),
    lastName: BoundedNameSchema.nullable(),
    username: BoundedNameSchema.nullable().default(null),
    avatar: ImageRefSchema.nullable(),
    github: GitHubProfileSchema.nullable(),
}).strict();

export type GitHubProfile = z.infer<typeof GitHubProfileSchema>;
export type ImageRef = z.infer<typeof ImageRefSchema>;
export type Profile = z.infer<typeof ProfileSchema>;

//
// Defaults
//

export const profileDefaults: Profile = {
    id: '',
    timestamp: 0,
    firstName: null,
    lastName: null,
    username: null,
    avatar: null,
    github: null,
};
Object.freeze(profileDefaults);

//
// Parsing
//

export function profileParse(profile: unknown): Profile {
    const parsed = ProfileSchema.safeParse(profile);
    if (!parsed.success) {
        console.error('Failed to parse profile');
        return { ...profileDefaults };
    }
    return parsed.data;
}

//
// Utility functions
//

export function getDisplayName(profile: Profile): string | null {
    if (profile.firstName || profile.lastName) {
        return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    }
    if (profile.github?.name) {
        return profile.github.name;
    }
    if (profile.github?.login) {
        return profile.github.login;
    }
    return null;
}

export function getAvatarUrl(profile: Profile, serverUrl: string): string | null {
    if (profile.avatar?.url) {
        try {
            const avatarUrl = new URL(profile.avatar.url);
            const configuredServerUrl = new URL(serverUrl);
            if (
                avatarUrl.origin === configuredServerUrl.origin
                && !avatarUrl.username
                && !avatarUrl.password
                && avatarUrl.search === ''
                && avatarUrl.hash === ''
                && avatarUrl.pathname === `/files/${profile.avatar.path}`
            ) {
                return avatarUrl.toString();
            }
        } catch {
            // Fall through to the separately allowlisted GitHub avatar.
        }
    }
    if (profile.github?.avatar_url) {
        try {
            const avatarUrl = new URL(profile.github.avatar_url);
            if (
                avatarUrl.protocol === 'https:'
                && avatarUrl.hostname === 'avatars.githubusercontent.com'
                && avatarUrl.port === ''
                && !avatarUrl.username
                && !avatarUrl.password
                && avatarUrl.hash === ''
                && /^\/u\/\d+(?:\/.*)?$/.test(avatarUrl.pathname)
            ) {
                return avatarUrl.toString();
            }
        } catch {
            return null;
        }
    }
    return null;
}

export function getBio(profile: Profile): string | null {
    return profile.github?.bio || null;
}
