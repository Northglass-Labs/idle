import { describe, expect, it } from 'vitest';
import { en as canonicalEnglish } from './_default';
import { ca } from './translations/ca';
import { en } from './translations/en';
import { es } from './translations/es';
import { it as itLocale } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';

const locales = {
    canonicalEnglish,
    ca,
    en,
    es,
    it: itLocale,
    ja,
    pl,
    pt,
    ru,
    zhHans,
    zhHant,
};

const forbiddenOverclaims = [
    /fully end-to-end encrypted/i,
    /stored only on your device/i,
    /never sent to any server/i,
    /only you can decrypt/i,
    /mai s['’]ha enviat a cap servidor/i,
    /nunca fue enviado a ningún servidor/i,
    /non è mai stata inviata a nessun server/i,
    /サーバーには送信されません/,
    /nigdy nie został wysłany/,
    /nunca foi enviado para nenhum servidor/i,
    /никогда не отправлялась на сервер/i,
    /从未发送到任何服务器/,
    /從未傳送到任何伺服器/,
];

describe('localized security disclosures', () => {
    it('does not claim that all data is E2EE, device-only, or invisible to the relay', () => {
        for (const [name, locale] of Object.entries(locales)) {
            const disclosure = [
                locale.settings.aboutFooter,
                locale.welcome.subtitle,
                locale.terminal.securityFooter,
                locale.terminal.securityFooterDevice,
            ].join('\n');

            for (const overclaim of forbiddenOverclaims) {
                expect(disclosure, `${name}: ${overclaim}`).not.toMatch(overclaim);
            }
        }
    });

    it('keeps the authority warning and pairing action localizable in every locale', () => {
        for (const [name, locale] of Object.entries(locales)) {
            expect(locale.terminal.pairingGrantTitle.length, `${name} title`).toBeGreaterThan(8);
            expect(
                locale.terminal.pairingGrantDescription.length,
                `${name} description`,
            ).toBeGreaterThan(60);
            expect(locale.terminal.pairTerminal.length, `${name} action`).toBeGreaterThan(3);
        }
    });
});
