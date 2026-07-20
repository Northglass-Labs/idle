import { describe, expect, it } from 'vitest';

import { en as defaultCopy } from '@/text/_default';
import { ca } from '@/text/translations/ca';
import { en } from '@/text/translations/en';
import { es } from '@/text/translations/es';
import { it as itCopy } from '@/text/translations/it';
import { ja } from '@/text/translations/ja';
import { pl } from '@/text/translations/pl';
import { pt } from '@/text/translations/pt';
import { ru } from '@/text/translations/ru';
import { zhHans } from '@/text/translations/zh-Hans';
import { zhHant } from '@/text/translations/zh-Hant';
import { resolveDirectVoiceAgentId } from './voiceConnectionPolicy';

describe('resolveDirectVoiceAgentId', () => {
    it('uses an explicitly configured custom agent for direct voice', () => {
        expect(resolveDirectVoiceAgentId(true, '  custom-agent  ')).toBe('custom-agent');
    });

    it.each([null, undefined, '', '   '])(
        'rejects direct voice without a user-supplied agent: %j',
        (agentId) => {
            expect(resolveDirectVoiceAgentId(true, agentId)).toBeNull();
        },
    );

    it('does not expose a direct agent when bypass is disabled', () => {
        expect(resolveDirectVoiceAgentId(false, 'custom-agent')).toBeNull();
    });

    it.each([
        'agent id with spaces',
        'https://example.test/agent',
        'agent\nvalue',
        'x'.repeat(129),
    ])('rejects an invalid or oversized agent identifier: %j', (agentId) => {
        expect(resolveDirectVoiceAgentId(true, agentId)).toBeNull();
    });

    it('keeps every locale explicit that direct connection requires a user-supplied agent ID', () => {
        expect(resolveDirectVoiceAgentId(true, '')).toBeNull();

        const copies = [
            {
                locale: 'default',
                copy: defaultCopy.settingsVoice,
                intro: 'Configure your own ElevenLabs agent for direct connection.',
                required: 'Required for direct connection. Enter your ElevenLabs agent ID; direct connection does not use an Idle default.',
            },
            {
                locale: 'en', copy: en.settingsVoice,
                intro: 'Configure your own ElevenLabs agent for direct connection.',
                required: 'Required for direct connection. Enter your ElevenLabs agent ID; direct connection does not use an Idle default.',
            },
            {
                locale: 'ca', copy: ca.settingsVoice,
                intro: "Configura el teu propi agent d'ElevenLabs per a la connexió directa.",
                required: "Obligatori per a la connexió directa. Introdueix l'ID del teu agent d'ElevenLabs; la connexió directa no utilitza cap agent predeterminat d'Idle.",
            },
            {
                locale: 'es', copy: es.settingsVoice,
                intro: 'Configura tu propio agente de ElevenLabs para la conexión directa.',
                required: 'Obligatorio para la conexión directa. Introduce el ID de tu agente de ElevenLabs; la conexión directa no utiliza ningún agente predeterminado de Idle.',
            },
            {
                locale: 'it', copy: itCopy.settingsVoice,
                intro: 'Configura il tuo agente ElevenLabs per la connessione diretta.',
                required: "Obbligatorio per la connessione diretta. Inserisci l'ID del tuo agente ElevenLabs; la connessione diretta non usa un agente predefinito di Idle.",
            },
            {
                locale: 'ja', copy: ja.settingsVoice,
                intro: '直接接続用に独自の ElevenLabs エージェントを設定します。',
                required: '直接接続には必須です。ElevenLabs Agent ID を入力してください。直接接続では Idle のデフォルトエージェントは使用されません。',
            },
            {
                locale: 'pl', copy: pl.settingsVoice,
                intro: 'Skonfiguruj własnego agenta ElevenLabs do połączenia bezpośredniego.',
                required: 'Wymagane do połączenia bezpośredniego. Wprowadź identyfikator agenta ElevenLabs; połączenie bezpośrednie nie używa domyślnego agenta Idle.',
            },
            {
                locale: 'pt', copy: pt.settingsVoice,
                intro: 'Configure seu próprio agente ElevenLabs para conexão direta.',
                required: 'Obrigatório para conexão direta. Insira o ID do seu agente ElevenLabs; a conexão direta não usa um agente padrão do Idle.',
            },
            {
                locale: 'ru', copy: ru.settingsVoice,
                intro: 'Настройте собственного агента ElevenLabs для прямого подключения.',
                required: 'Обязательно для прямого подключения. Введите ID агента ElevenLabs; прямое подключение не использует агента Idle по умолчанию.',
            },
            {
                locale: 'zh-Hans', copy: zhHans.settingsVoice,
                intro: '配置您自己的 ElevenLabs 代理以进行直接连接。',
                required: '直接连接时必填。请输入您的 ElevenLabs Agent ID；直接连接不会使用 Idle 默认代理。',
            },
            {
                locale: 'zh-Hant', copy: zhHant.settingsVoice,
                intro: '設定您自己的 ElevenLabs 代理以進行直接連線。',
                required: '直接連線時必填。請輸入您的 ElevenLabs Agent ID；直接連線不會使用 Idle 預設代理。',
            },
        ];

        for (const { locale, copy, intro, required } of copies) {
            expect(copy.byoDescription.startsWith(intro), locale).toBe(true);
            expect(copy.customAgentIdDescription, locale).toBe(required);
        }

        expect([
            defaultCopy.errors.voiceHardLimitReached({ hours: 5 }),
            en.errors.voiceHardLimitReached({ hours: 5 }),
            ca.errors.voiceHardLimitReached({ hours: 5 }),
            es.errors.voiceHardLimitReached({ hours: 5 }),
            itCopy.errors.voiceHardLimitReached({ hours: 5 }),
            ja.errors.voiceHardLimitReached({ hours: 5 }),
            pl.errors.voiceHardLimitReached({ hours: 5 }),
            pt.errors.voiceHardLimitReached({ hours: 5 }),
            ru.errors.voiceHardLimitReached({ hours: 5 }),
            zhHans.errors.voiceHardLimitReached({ hours: 5 }),
            zhHant.errors.voiceHardLimitReached({ hours: 5 }),
        ]).toEqual([
            "You've used 5+ hours of voice this month. This is the maximum allowed. Voice will be available again when the monthly limit resets.",
            "You've used 5+ hours of voice this month. This is the maximum allowed. Voice will be available again when the monthly limit resets.",
            'Has utilitzat 5+ hores de veu aquest mes. Aquest és el màxim permès. La veu tornarà a estar disponible quan es restableixi el límit mensual.',
            'Has usado 5+ horas de voz este mes. Este es el máximo permitido. La voz volverá a estar disponible cuando se restablezca el límite mensual.',
            'Hai utilizzato 5+ ore di voce questo mese. Questo è il massimo consentito. La voce sarà nuovamente disponibile quando il limite mensile verrà reimpostato.',
            '今月5時間以上の音声を使用しました。これは許可される最大量です。月間上限がリセットされると、音声を再び利用できます。',
            'Wykorzystałeś 5+ godzin głosu w tym miesiącu. To jest maksymalny dozwolony limit. Głos będzie ponownie dostępny po zresetowaniu miesięcznego limitu.',
            'Você usou 5+ horas de voz este mês. Este é o máximo permitido. A voz estará disponível novamente quando o limite mensal for redefinido.',
            'Вы использовали 5+ часов голосового общения в этом месяце. Это максимально допустимый лимит. Голос снова станет доступен после сброса месячного лимита.',
            '您本月已使用超过 5 小时的语音。这是允许的最大用量。每月限额重置后，语音将再次可用。',
            '您本月已使用超過 5 小時的語音。這是允許的最大用量。每月限額重設後，語音將再次可用。',
        ]);

        expect([
            defaultCopy.errors.voiceConversationLimitReached,
            en.errors.voiceConversationLimitReached,
            ca.errors.voiceConversationLimitReached,
            es.errors.voiceConversationLimitReached,
            itCopy.errors.voiceConversationLimitReached,
            ja.errors.voiceConversationLimitReached,
            pl.errors.voiceConversationLimitReached,
            pt.errors.voiceConversationLimitReached,
            ru.errors.voiceConversationLimitReached,
            zhHans.errors.voiceConversationLimitReached,
            zhHant.errors.voiceConversationLimitReached,
        ]).toEqual([
            "You've reached the maximum number of voice conversations this month. Voice will be available again when the monthly conversation limit resets.",
            "You've reached the maximum number of voice conversations this month. Voice will be available again when the monthly conversation limit resets.",
            'Has assolit el nombre màxim de converses de veu aquest mes. La veu tornarà a estar disponible quan es restableixi el límit mensual de converses.',
            'Has alcanzado el número máximo de conversaciones de voz este mes. La voz volverá a estar disponible cuando se restablezca el límite mensual de conversaciones.',
            'Hai raggiunto il numero massimo di conversazioni vocali questo mese. La voce sarà nuovamente disponibile quando il limite mensile di conversazioni verrà reimpostato.',
            '今月の音声会話の最大数に達しました。月間会話上限がリセットされると、音声を再び利用できます。',
            'Osiągnąłeś maksymalną liczbę rozmów głosowych w tym miesiącu. Głos będzie ponownie dostępny po zresetowaniu miesięcznego limitu rozmów.',
            'Você atingiu o número máximo de conversas de voz este mês. A voz estará disponível novamente quando o limite mensal de conversas for redefinido.',
            'Вы достигли максимального количества голосовых разговоров в этом месяце. Голос снова станет доступен после сброса месячного лимита разговоров.',
            '您本月已达到语音对话的最大次数。每月对话限额重置后，语音将再次可用。',
            '您本月已達到語音對話的最大次數。每月對話限額重設後，語音將再次可用。',
        ]);
    });
});
