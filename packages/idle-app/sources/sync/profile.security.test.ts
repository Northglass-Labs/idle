import { describe, expect, it } from 'vitest';

import {
    getAvatarUrl,
    GitHubProfileSchema,
    ImageRefSchema,
    ProfileSchema,
} from './profile';

const github = {
    id: 123,
    login: 'octocat',
    name: 'Octo Cat',
    avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4',
    email: 'octocat@example.com',
    bio: 'Builder',
};

const avatar = {
    width: 100,
    height: 100,
    thumbhash: 'YWJjZA==',
    path: 'public/users/account-1/avatars/github-1.jpg',
    url: 'https://relay.example/files/public/users/account-1/avatars/github-1.jpg',
};

const profile = {
    id: 'account-1',
    timestamp: 1,
    firstName: 'Octo',
    lastName: 'Cat',
    avatar,
    github,
};

describe('bounded account profile schemas', () => {
    it('accepts the current bounded relay profile shape', () => {
        expect(ProfileSchema.safeParse(profile).success).toBe(true);
    });

    it('rejects unbounded nested GitHub strings and unsafe numeric IDs', () => {
        expect(GitHubProfileSchema.safeParse({ ...github, id: Number.POSITIVE_INFINITY }).success).toBe(false);
        expect(GitHubProfileSchema.safeParse({ ...github, login: 'x'.repeat(257) }).success).toBe(false);
        expect(GitHubProfileSchema.safeParse({ ...github, name: 'x'.repeat(257) }).success).toBe(false);
        expect(GitHubProfileSchema.safeParse({ ...github, avatar_url: `https://avatars.githubusercontent.com/u/${'1'.repeat(2_049)}` }).success).toBe(false);
        expect(GitHubProfileSchema.safeParse({ ...github, email: `${'x'.repeat(250)}@example.com` }).success).toBe(false);
        expect(GitHubProfileSchema.safeParse({ ...github, bio: 'x'.repeat(8_193) }).success).toBe(false);
    });

    it('rejects unbounded image dimensions, references, and URL fields', () => {
        expect(ImageRefSchema.safeParse({ ...avatar, width: Number.NaN }).success).toBe(false);
        expect(ImageRefSchema.safeParse({ ...avatar, height: 100_001 }).success).toBe(false);
        expect(ImageRefSchema.safeParse({ ...avatar, thumbhash: 'x'.repeat(1_025) }).success).toBe(false);
        expect(ImageRefSchema.safeParse({ ...avatar, path: `public/users/account-1/avatars/${'x'.repeat(256)}` }).success).toBe(false);
        expect(ImageRefSchema.safeParse({ ...avatar, url: `https://relay.example/${'x'.repeat(2_049)}` }).success).toBe(false);
    });

    it('bounds the profile envelope and rejects unknown state', () => {
        expect(ProfileSchema.safeParse({ ...profile, id: 'x'.repeat(65) }).success).toBe(false);
        expect(ProfileSchema.safeParse({ ...profile, firstName: 'x'.repeat(257) }).success).toBe(false);
        expect(ProfileSchema.safeParse({
            ...profile,
            connectedServices: ['anthropic'],
        }).success).toBe(false);
    });
});

describe('avatar fetch policy', () => {
    it('allows only the exact relay-owned avatar object path', () => {
        expect(getAvatarUrl(profile, 'https://relay.example')).toBe(avatar.url);
        expect(getAvatarUrl({
            ...profile,
            avatar: { ...avatar, url: 'https://tracker.example/pixel.png?id=account-1' },
            github: null,
        }, 'https://relay.example')).toBeNull();
        expect(getAvatarUrl({
            ...profile,
            avatar: { ...avatar, url: 'http://127.0.0.1/private' },
            github: null,
        }, 'https://relay.example')).toBeNull();
    });

    it('allows the exact GitHub avatar host as a bounded fallback', () => {
        expect(getAvatarUrl({ ...profile, avatar: null }, 'https://relay.example')).toBe(github.avatar_url);
        expect(getAvatarUrl({
            ...profile,
            avatar: null,
            github: { ...github, avatar_url: 'https://avatars.githubusercontent.com.evil.example/u/123' },
        }, 'https://relay.example')).toBeNull();
        expect(getAvatarUrl({
            ...profile,
            avatar: null,
            github: { ...github, avatar_url: ['https://user', ':pass@avatars.githubusercontent.com/u/123'].join('') },
        }, 'https://relay.example')).toBeNull();
    });
});
