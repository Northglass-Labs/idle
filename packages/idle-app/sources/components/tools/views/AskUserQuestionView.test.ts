import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    sessionAllow: vi.fn(),
    theme: {
        colors: {
            button: { primary: { background: '#000', tint: '#fff' } },
            divider: '#ccc',
            radio: { active: '#00f', dot: '#00f' },
            surfaceHigh: '#eee',
            surfaceHighest: '#ddd',
            text: '#111',
            textSecondary: '#666',
        },
    },
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (value: unknown) => typeof value === 'function'
            ? (value as (themeValue: typeof mocks.theme) => unknown)(mocks.theme)
            : value,
    },
    useUnistyles: () => ({ theme: mocks.theme }),
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Ionicons' }));
vi.mock('@expo/vector-icons/Octicons', () => ({ default: 'Octicons' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/ops', () => ({ sessionAllow: mocks.sessionAllow }));
vi.mock('../ToolSectionView', () => ({ ToolSectionView: 'ToolSectionView' }));

import { knownTools, parseAskUserQuestionInput } from '../knownTools';
import { AskUserQuestionView } from './AskUserQuestionView';

const validInput = {
    questions: [
        {
            question: 'Choose an environment',
            header: 'Environment',
            options: [
                { label: 'Production', description: 'Use the production environment' },
                { label: 'Staging', description: 'Use the staging environment' },
            ],
            multiSelect: false,
        },
        {
            question: 'Select checks',
            header: 'Checks',
            options: [
                { label: 'Tests', description: 'Run focused tests' },
                { label: 'Typecheck', description: 'Run the TypeScript checker' },
            ],
            multiSelect: true,
        },
    ],
};

function tool(input: unknown) {
    return {
        name: 'AskUserQuestion',
        state: 'running' as const,
        input,
        createdAt: 0,
        startedAt: null,
        completedAt: null,
        description: null,
        permission: {
            id: 'permission-1',
            status: 'pending' as const,
        },
    };
}

async function render(input: unknown) {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
        renderer = TestRenderer.create(React.createElement(AskUserQuestionView, {
            tool: tool(input),
            metadata: null,
            messages: [],
            sessionId: 'session-1',
        }));
    });
    return renderer!;
}

describe('AskUserQuestion input boundary', () => {
    beforeEach(() => {
        mocks.sessionAllow.mockReset();
        mocks.sessionAllow.mockResolvedValue(undefined);
    });

    it('accepts a complete bounded payload', () => {
        expect(knownTools.AskUserQuestion.input.safeParse(validInput).success).toBe(true);
    });

    it.each([
        ['missing questions', {}],
        ['missing required options', { questions: [{ question: 'Q', header: 'H', multiSelect: false }] }],
        ['non-string question', { questions: [{ ...validInput.questions[0], question: 1 }] }],
        ['blank question', { questions: [{ ...validInput.questions[0], question: '   ' }] }],
        ['non-string header', { questions: [{ ...validInput.questions[0], header: false }] }],
        ['blank header', { questions: [{ ...validInput.questions[0], header: '   ' }] }],
        ['non-boolean multiSelect', { questions: [{ ...validInput.questions[0], multiSelect: 'false' }] }],
        ['non-string option label', { questions: [{ ...validInput.questions[0], options: [{ label: 1, description: 'D' }] }] }],
        ['blank option label', { questions: [{ ...validInput.questions[0], options: [{ label: ' ', description: 'D' }] }] }],
        ['missing option description', { questions: [{ ...validInput.questions[0], options: [{ label: 'L' }] }] }],
        ['non-string option description', { questions: [{ ...validInput.questions[0], options: [{ label: 'L', description: null }] }] }],
        ['blank option description', { questions: [{ ...validInput.questions[0], options: [{ label: 'L', description: '   ' }] }] }],
        ['too many questions', { questions: Array.from({ length: 5 }, () => validInput.questions[0]) }],
        ['too many options', { questions: [{ ...validInput.questions[0], options: Array.from({ length: 5 }, () => validInput.questions[0].options[0]) }] }],
        ['oversized question', { questions: [{ ...validInput.questions[0], question: 'q'.repeat(2001) }] }],
        ['oversized header', { questions: [{ ...validInput.questions[0], header: 'h'.repeat(65) }] }],
        ['oversized option label', { questions: [{ ...validInput.questions[0], options: [{ label: 'l'.repeat(201), description: 'D' }] }] }],
        ['oversized option description', { questions: [{ ...validInput.questions[0], options: [{ label: 'L', description: 'd'.repeat(1001) }] }] }],
        ['unexpected top-level field', { ...validInput, internal: true }],
        ['unexpected question field', { questions: [{ ...validInput.questions[0], internal: true }] }],
        ['unexpected option field', { questions: [{ ...validInput.questions[0], options: [{ ...validInput.questions[0].options[0], internal: true }] }] }],
    ])('rejects %s', (_label, input) => {
        expect(knownTools.AskUserQuestion.input.safeParse(input).success).toBe(false);
    });

    it('rejects oversized collections before deep parsing', () => {
        const input = { questions: Array.from({ length: 10_000 }, () => validInput.questions[0]) };

        expect(parseAskUserQuestionInput(input)).toBeNull();
    });

    it('uses safe title and subtitle fallbacks for malformed input', () => {
        const malformedTool = tool({ questions: [{ header: { nested: true }, question: ['bad'] }] });

        expect(knownTools.AskUserQuestion.title({ tool: malformedTool, metadata: null })).toBe('tools.names.question');
        expect(knownTools.AskUserQuestion.extractSubtitle({ tool: malformedTool, metadata: null })).toBeNull();
    });

    it('renders a safe failure fallback instead of throwing', async () => {
        const renderer = await render({ questions: [{ question: 'Missing options' }] });
        const text = renderer.root.findAllByType('Text').map((node) => node.children.join(' '));

        expect(text).toContain('common.error');
        expect(renderer.root.findByProps({ accessibilityRole: 'alert' })).toBeDefined();
        expect(renderer.root.findAllByType('TouchableOpacity')).toHaveLength(0);

        await act(async () => renderer.unmount());
    });

    it('preserves multi-question and multi-select submission', async () => {
        const renderer = await render(validInput);
        let buttons = renderer.root.findAllByType('TouchableOpacity');

        await act(async () => {
            buttons[0].props.onPress();
            buttons[2].props.onPress();
            buttons[3].props.onPress();
        });

        buttons = renderer.root.findAllByType('TouchableOpacity');
        const submit = buttons.at(-1)!;
        expect(submit.props.disabled).toBe(false);

        await act(async () => {
            await submit.props.onPress();
        });

        expect(mocks.sessionAllow).toHaveBeenCalledWith(
            'session-1',
            'permission-1',
            undefined,
            undefined,
            'approved',
            {
                answers: {
                    'Choose an environment': 'Production',
                    'Select checks': 'Tests, Typecheck',
                },
            },
        );

        await act(async () => renderer.unmount());
    });
});
