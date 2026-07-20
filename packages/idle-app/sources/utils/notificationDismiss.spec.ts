import { describe, expect, it } from 'vitest';
import { notificationMatchesSession, type NotificationLike } from './notificationMatch';

function makeNotif(data: unknown, id = 'notif-1'): NotificationLike {
    return { request: { identifier: id, content: { data } } };
}

describe('notificationMatchesSession', () => {
    it('matches when data.sessionId equals the target', () => {
        const n = makeNotif({ sessionId: 'sess-123' });
        expect(notificationMatchesSession(n, 'sess-123')).toBe(true);
    });

    it('does not match a different sessionId', () => {
        const n = makeNotif({ sessionId: 'sess-other' });
        expect(notificationMatchesSession(n, 'sess-123')).toBe(false);
    });

    it('does not match when data is undefined (defensive)', () => {
        const n = makeNotif(undefined);
        expect(notificationMatchesSession(n, 'sess-123')).toBe(false);
    });

    it('does not match when data is null', () => {
        const n = makeNotif(null);
        expect(notificationMatchesSession(n, 'sess-123')).toBe(false);
    });

    it('does not match when data is a primitive (string, number)', () => {
        expect(notificationMatchesSession(makeNotif('hello'), 'sess-123')).toBe(false);
        expect(notificationMatchesSession(makeNotif(42), 'sess-123')).toBe(false);
    });

    it('does not match when sessionId field is missing', () => {
        const n = makeNotif({ otherField: 'value' });
        expect(notificationMatchesSession(n, 'sess-123')).toBe(false);
    });

    it('does not match when sessionId is a different type', () => {
        const n = makeNotif({ sessionId: 123 });
        expect(notificationMatchesSession(n, 'sess-123')).toBe(false);
    });

    it('ignores extra fields in data (forward compat)', () => {
        const n = makeNotif({ sessionId: 'sess-123', futureField: 'whatever', nested: { foo: 1 } });
        expect(notificationMatchesSession(n, 'sess-123')).toBe(true);
    });
});
