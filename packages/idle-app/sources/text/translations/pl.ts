import type { TranslationStructure } from '../_default';

/**
 * Polish plural helper function
 * Polish has 3 plural forms: one, few, many
 * @param options - Object containing count and the three plural forms
 * @returns The appropriate form based on Polish plural rules
 */
function plural({ count, one, few, many }: { count: number; one: string; few: string; many: string }): string {
    const n = Math.abs(count);
    const n10 = n % 10;
    const n100 = n % 100;

    // Rule: 1 (but not 11)
    if (n === 1) return one;

    // Rule: 2-4 but not 12-14
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;

    // Rule: everything else (0, 5-19, 11, 12-14, etc.)
    return many;
}

/**
 * Polish translations for the Idle app
 * Must match the exact structure of the English translations
 */
export const pl: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Terminale',
        settings: 'Ustawienia',
    },

    common: {
        // Simple string constants
        cancel: 'Anuluj',
        done: 'Done',
        authenticate: 'Uwierzytelnij',
        save: 'Zapisz',
        saveAs: 'Zapisz jako',
        error: 'Błąd',
        success: 'Sukces',
        ok: 'OK',
        continue: 'Kontynuuj',
        back: 'Wstecz',
        create: 'Utwórz',
        rename: 'Zmień nazwę',
        reset: 'Resetuj',
        logout: 'Wyloguj',
        yes: 'Tak',
        no: 'Nie',
        discard: 'Odrzuć',
        version: 'Wersja',
        copied: 'Skopiowano',
        copy: 'Kopiuj',
        scanning: 'Skanowanie...',
        urlPlaceholder: 'https://example.com',
        home: 'Główna',
        message: 'Wiadomość',
        files: 'Pliki',
        fileViewer: 'Przeglądarka plików',
        loading: 'Ładowanie...',
        retry: 'Ponów',
        delete: 'Usuń',
        optional: 'opcjonalnie',
        moreActions: 'Więcej akcji',
        dismissHint: 'Zamknij wskazówkę',
    },

    profile: {
        userProfile: 'Profil użytkownika',
        details: 'Szczegóły',
        firstName: 'Imię',
        lastName: 'Nazwisko',
        username: 'Nazwa użytkownika',
        status: 'Status',
    },


    status: {
        connected: 'połączono',
        connecting: 'łączenie',
        disconnected: 'rozłączono',
        error: 'błąd',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `ostatnio widziano ${time}`,
        permissionRequired: 'wymagane uprawnienie',
        activeNow: 'Aktywny teraz',
        unknown: 'nieznane',
        unread: 'nowe wyniki',
    },

    time: {
        justNow: 'teraz',
        minutesAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'minuta', few: 'minuty', many: 'minut' })} temu`,
        hoursAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'godzina', few: 'godziny', many: 'godzin' })} temu`,
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'dzień', few: 'dni', many: 'dni' })} temu`,
    },

    connect: {
        restoreAccount: 'Przywróć konto',
        enterSecretKey: 'Proszę wprowadzić klucz tajny',
        invalidSecretKey: 'Nieprawidłowy klucz tajny. Sprawdź i spróbuj ponownie.',
        enterUrlManually: 'Wprowadź URL ręcznie',
        enterUrlManuallyInfo: 'Użyj tego, gdy nie możesz zeskanować QR — skopiuj URL idle:// z wyjścia terminala i wklej go tutaj. Ten sam efekt co skanowanie.',
    },

    settings: {
        title: 'Ustawienia',
        connectedAccounts: 'Połączone konta',
        connectAccount: 'Połącz konto',
        github: 'GitHub',
        machines: 'Maszyny',
        showOfflineMachines: ({ count }: { count: number }) => {
            const mod10 = count % 10;
            const mod100 = count % 100;
            if (count === 1) return 'Pokaż 1 maszynę offline';
            if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `Pokaż ${count} maszyny offline`;
            return `Pokaż ${count} maszyn offline`;
        },
        hideOfflineMachines: 'Ukryj maszyny offline',
        features: 'Funkcje',
        account: 'Konto',
        accountSubtitle: 'Zarządzaj szczegółami konta',
        appearance: 'Wygląd',
        appearanceSubtitle: 'Dostosuj wygląd aplikacji',
        voiceAssistant: 'Asystent głosowy',
        voiceAssistantSubtitle: 'Konfiguruj preferencje interakcji głosowej',
        voiceAssistantInfo: 'Gdy głos jest aktywny, Idle wysyła do ElevenLabs dźwięk, tytuły i podsumowania aktywnych sesji, aktualizacje transkrypcji bieżącej i odpowiednich sesji w tle, nieprzezroczyste identyfikatory sesji/żądań oraz nazwy narzędzi uprawnień potrzebne do sterowania wieloma sesjami. Idle nie dodaje osobno zapisanych ścieżek projektów ani argumentów uprawnień. Sam tekst transkrypcji może zawierać dane wrażliwe. Pozostaw głos wyłączony, aby nie wysyłać tych danych do ElevenLabs.',
        featuresTitle: 'Funkcje',
        featuresSubtitle: 'Włącz lub wyłącz funkcje aplikacji',
        developer: 'Deweloper',
        about: 'O aplikacji',
        aboutFooter: 'Idle to mobilny klient Codex i Claude Code. Treść sesji jest szyfrowana end-to-end. Przekaźnik przechowuje metadane konta, routingu i działania potrzebne do synchronizacji; klucze konta pozostają na autoryzowanych urządzeniach. Idle nie jest powiązany z Anthropic.',
        whatsNew: 'Co nowego',
        whatsNewSubtitle: 'Zobacz najnowsze aktualizacje i ulepszenia',
        reportIssue: 'Zgłoś problem',
        privacyPolicy: 'Polityka prywatności',
        termsOfService: 'Warunki użytkowania',
        eula: 'EULA',
        supportUs: 'Wesprzyj nas',
        supportUsSubtitlePro: 'Dziękujemy za wsparcie!',
        supportUsSubtitle: 'Wesprzyj rozwój projektu',
        scanQrCodeToAuthenticate: 'Zeskanuj kod QR, aby się uwierzytelnić',
        scanQrInfo: 'Parowanie pozwala telefonowi wysyłać wiadomości do sesji Claude Code na twoim komputerze. Kod QR zawiera jednorazowy klucz, który upoważnia to urządzenie do sterowania terminalem.',
        githubConnected: ({ login }: { login: string }) => `Połączono jako @${login}`,
        githubInfo: 'Używane do logowania przez GitHub i do pobierania metadanych repozytoriów w niektórych przepływach. Rozłączenie usuwa tylko dostęp do GitHub — twoje konto Idle pozostaje nietknięte.',
        connectGithubAccount: 'Połącz konto GitHub',
        usage: 'Użycie',
        usageSubtitle: 'Zobacz użycie API i koszty',

        // Dynamic settings messages
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} jest ${status === 'online' ? 'online' : 'offline'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'włączona' : 'wyłączona'}`,
        // Settings section titles and menu rows
        sectionPairTerminal: 'Paruj terminal',
        sectionConnected: 'Połączone',
        sectionApp: 'Aplikacja',
        sectionAdvanced: 'Zaawansowane',
        sectionHelp: 'Pomoc i opinie',
        language: 'Język',
        languageSubtitle: 'Wybierz preferowany język wyświetlania',
        claudeCode: 'Agenci programistyczni',
        claudeCodeInfo: 'Claude Code, Codex i Gemini uwierzytelniają się na sparowanym komputerze przez oficjalne interfejsy CLI. Idle nigdy nie przechowuje tych danych logowania dostawców.',
        labFeatures: 'Funkcje Laboratorium',
        labFeaturesSubtitle: 'Wypróbuj eksperymentalne funkcje w trakcie rozwoju',
        labFeaturesInfo: 'Eksperymentalne przełączniki. Mogą się zmienić, zepsuć lub zostać usunięte w przyszłych aktualizacjach. Można je wypróbować, ale nie polegaj na nich długoterminowo.',
    },

    settingsAppearance: {
        commitAttribution: 'Commit attribution',
        commitAttributionDescription: 'Credit Idle in commits made through the app',
        commitAttributionInfo: 'When on, commits made through Idle add a "Co-Authored-By: Idle" credit (alongside Claude\'s). Off by default, so your commit history stays clean unless you opt in.',
        // Appearance settings screen
        theme: 'Motyw',
        themeDescription: 'Wybierz preferowaną kolorystykę',
        themeOptions: {
            adaptive: 'Adaptacyjny',
            light: 'Jasny',
            dark: 'Ciemny',
        },
        themeDescriptions: {
            adaptive: 'Dopasuj do ustawień systemu',
            light: 'Zawsze używaj jasnego motywu',
            dark: 'Zawsze używaj ciemnego motywu',
        },
        display: 'Wyświetlanie',
        displayDescription: 'Kontroluj układ i odstępy',
        inlineToolCalls: 'Wbudowane wywołania narzędzi',
        inlineToolCallsDescription: 'Wyświetlaj wywołania narzędzi bezpośrednio w wiadomościach czatu',
        expandTodoLists: 'Rozwiń listy zadań',
        expandTodoListsDescription: 'Pokazuj wszystkie zadania zamiast tylko zmian',
        showLineNumbersInDiffs: 'Pokaż numery linii w różnicach',
        showLineNumbersInDiffsDescription: 'Wyświetlaj numery linii w różnicach kodu',
        showLineNumbersInToolViews: 'Pokaż numery linii w widokach narzędzi',
        showLineNumbersInToolViewsDescription: 'Wyświetlaj numery linii w różnicach widoków narzędzi',
        wrapLinesInDiffs: 'Zawijanie linii w różnicach',
        wrapLinesInDiffsDescription: 'Zawijaj długie linie zamiast przewijania poziomego w widokach różnic',
        diffStyle: 'Widok różnic',
        diffStyleDescription: 'Pokazuj różnice w jednej kolumnie (unified) lub obok siebie (split). Widok split działa tylko w przeglądarce.',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: 'Zawsze pokazuj rozmiar kontekstu',
        alwaysShowContextSizeDescription: 'Wyświetlaj użycie kontekstu nawet gdy nie jest blisko limitu',
        avatarStyle: 'Styl awatara',
        avatarStyleDescription: 'Wybierz wygląd awatara sesji',
        avatarOptions: {
            pixelated: 'Pikselowy',
            gradient: 'Gradientowy',
            brutalist: 'Brutalistyczny',
            northglass: 'Northglass',
        },
        showFlavorIcons: 'Pokaż ikony dostawcy AI',
        showFlavorIconsDescription: 'Wyświetlaj ikony dostawcy AI na awatarach sesji',
        showMessageTimestamps: 'Show Message Timestamps',
        showMessageTimestampsDescription: 'Display timestamps under chat bubbles and on session rows',
        compactSessionView: 'Kompaktowy widok sesji',
        compactSessionViewDescription: 'Pokazuj aktywne sesje w bardziej zwartym układzie',
        linksOpenIn: 'Otwieraj linki w',
        linksOpenInDescription: 'Wybierz, gdzie otwierają się linki',
        linksOpenInOptions: {
            'in-app': 'Przeglądarka w aplikacji',
            'external': 'Przeglądarka zewnętrzna',
        },
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Eksperymenty',
        experimentsDescription: 'Włącz eksperymentalne funkcje, które są nadal w rozwoju. Te funkcje mogą być niestabilne lub zmienić się bez ostrzeżenia.',
        experimentalFeatures: 'Funkcje eksperymentalne',
        experimentalFeaturesEnabled: 'Funkcje eksperymentalne włączone',
        experimentalFeaturesDisabled: 'Używane tylko stabilne funkcje',
        webFeatures: 'Funkcje webowe',
        webFeaturesDescription: 'Funkcje dostępne tylko w wersji webowej aplikacji.',
        enterToSend: 'Enter aby wysłać',
        enterToSendEnabled: 'Naciśnij Enter, aby wysłać (Shift+Enter dla nowej linii)',
        enterToSendDisabled: 'Enter wstawia nową linię',
        commandPalette: 'Paleta poleceń',
        commandPaletteEnabled: 'Naciśnij ⌘K, aby otworzyć',
        commandPaletteDisabled: 'Szybki dostęp do poleceń wyłączony',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Długie naciśnięcie otwiera modal kopiowania',
        hideInactiveSessions: 'Ukryj nieaktywne sesje',
        hideInactiveSessionsSubtitle: 'Wyświetlaj tylko aktywne czaty na liście',
        groupToolCalls: 'Grupuj wywołania narzędzi',
        groupToolCallsSubtitle: 'Zwijaj kolejne wywołania narzędzi w jeden kontener',
        privacy: 'Prywatność',
        privacyDescription: 'Całkowicie wyłącza wszystkie analizy i telemetrię. Żadne dane nie będą wysyłane do PostHog ani żadnego innego serwisu śledzącego.',
        disableAnalytics: 'Wyłącz analitykę',
        analyticsDisabled: 'Wszystkie śledzenie i telemetria wyłączone',
        analyticsEnabled: 'Opcjonalna analityka użytkowania aktywna',
        imageUpload: 'Przesyłanie obrazów',
        imageUploadSubtitle: 'Dołączaj obrazy do wiadomości, aby obsługiwani agenci mogli je analizować',
    },

    errors: {
        networkError: 'Wystąpił błąd sieci',
        serverError: 'Wystąpił błąd serwera',
        unknownError: 'Wystąpił nieznany błąd',
        connectionTimeout: 'Przekroczono czas oczekiwania na połączenie',
        authenticationFailed: 'Uwierzytelnienie nie powiodło się',
        permissionDenied: 'Brak uprawnień',
        fileNotFound: 'Plik nie został znaleziony',
        invalidFormat: 'Nieprawidłowy format',
        operationFailed: 'Operacja nie powiodła się',
        tryAgain: 'Spróbuj ponownie',
        contactSupport: 'Skontaktuj się z pomocą techniczną, jeśli problem będzie się powtarzał',
        sessionNotFound: 'Sesja nie została znaleziona',
        voiceSessionFailed: 'Nie udało się uruchomić sesji głosowej',
        voiceServiceUnavailable: 'Usługa głosowa jest tymczasowo niedostępna',
        voiceLimitReachedTitle: 'Osiągnięto limit głosu',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `Wykorzystałeś ${hours}+ godzin głosu w tym miesiącu. To jest maksymalny dozwolony limit. Głos będzie ponownie dostępny po zresetowaniu miesięcznego limitu.`,
        voiceConversationLimitReached: 'Osiągnąłeś maksymalną liczbę rozmów głosowych w tym miesiącu. Głos będzie ponownie dostępny po zresetowaniu miesięcznego limitu rozmów.',
        sessionDeleted: 'Sesja została usunięta',
        sessionDeletedDescription: 'Ta sesja została trwale usunięta',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} musi być między ${min} a ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Ponów próbę za ${seconds} ${plural({ count: seconds, one: 'sekundę', few: 'sekundy', many: 'sekund' })}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Błąd ${code})`,
    },

    newSession: {
        title: 'Rozpocznij nową sesję',
        machineOffline: 'Maszyna jest offline',
        switchMachinesHint: '• Przełącz maszynę, klikając na nią powyżej',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Historia sesji',
        empty: 'Nie znaleziono sesji',
        today: 'Dzisiaj',
        yesterday: 'Wczoraj',
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'dzień', few: 'dni', many: 'dni' })} temu`,
        viewAll: 'Zobacz wszystkie sesje',
    },

    session: {
        inputPlaceholder: 'Wpisz wiadomość...',
        inputPlaceholderResume: 'Wyślij wiadomość, aby wznowić sesję',
        inactiveArchived: 'Ta sesja jest nieaktywna.',
        resumeFromTerminal: 'Aby wznowić ją z terminala:',
        actions: 'Session Actions',
        moveToGroup: 'Move to Group',
        selectGroup: 'Select Group',
        removeFromGroup: 'Remove from Group',
        moveToGroupFrom: ({ name }: { name: string }) => `Move from "${name}"...`,
        moveToTop: 'Move to top',
        newGroup: 'New group...',
        newGroupTitle: 'New group',
        newGroupPlaceholder: 'Group name',
        rename: 'Rename',
        renameTitle: 'Rename session',
        renameMessage: 'Sets a custom name on this device only. Leave blank to restore the original.',
        renamePlaceholder: 'Session name',
        rearrangeSessions: 'Rearrange sessions',
        reorderHint: 'Long-press a row, then drag to a new spot.',
        ungroupedHeader: 'Ungrouped',
        renameGroup: 'Rename Group',
        renameGroupTitle: 'Rename Group',
        deleteGroup: 'Delete Group',
        deleteGroupTitle: 'Delete Group',
        deleteGroupMessage: 'Sessions in this group will be moved to ungrouped.',
        // Session action feedback and first-launch hint
        archiveMovedToast: 'Archiwizacja przeniesiona pod ⋯',
        actionsHintTip: 'Stuknij ⋯ na dowolnej sesji, aby zmienić nazwę, zarchiwizować lub przearanżować.',
        newChat: 'Nowy czat',
        forkAction: 'Rozwidl sesję',
        forkSubtitle: 'Kontynuuj w nowej sesji z tym samym kontekstem',
        duplicateAction: 'Duplikuj od wiadomości…',
        duplicateSubtitle: 'Cofnij się do wybranego punktu i spróbuj inaczej',
        forkFromHere: 'Rozwidl od tego miejsca',
        duplicateSheetTitle: 'Wybierz punkt cofnięcia',
        duplicateSheetSubtitle: 'Nowa sesja zachowa wybraną turę w całości (twoja wiadomość i odpowiedź agenta) i odrzuci wszystkie kolejne wiadomości.',
        duplicateSheetConfirm: 'Duplikuj',
        duplicateSheetEmpty: 'W tej sesji nie ma jeszcze wiadomości, do których można się cofnąć.',
        duplicateRowDisabled: 'Tej wiadomości nie można użyć jako punktu cofnięcia.',
        forkedFromLabel: 'Rozwidlone z',
        forkedFromSubtitle: 'Otwórz sesję, z której powstało rozwidlenie',
        forkErrorOffline: 'Maszyna jest offline. Rozwidlenie jest dostępne tylko gdy maszyna sesji jest online.',
        forkErrorMissingUuid: 'Wybrany punkt cofnięcia nie istnieje już w sesji źródłowej — spróbuj rozwidlić bez przycinania.',
        forkErrorMissingMetadata: 'Brak metadanych sesji wymaganych do rozwidlenia.',
        forkErrorGeneric: 'Nie udało się rozwidlić sesji.',
        forkClaudeOnly: 'Rozwidlenie jest obecnie obsługiwane tylko dla sesji Claude.',
    },

    commandPalette: {
        placeholder: 'Wpisz polecenie lub wyszukaj...',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'Konfiguracja serwera',
        enterServerUrl: 'Proszę wprowadzić URL serwera',
        notValidIdleServer: 'To nie jest prawidłowy serwer Idle',
        changeServer: 'Zmień serwer',
        continueWithServer: 'Kontynuować z tym serwerem?',
        resetToDefault: 'Resetuj do domyślnego',
        resetServerDefault: 'Zresetować serwer do domyślnego?',
        validating: 'Sprawdzanie...',
        validatingServer: 'Sprawdzanie serwera...',
        serverReturnedError: 'Serwer zwrócił błąd',
        failedToConnectToServer: 'Nie udało się połączyć z serwerem',
        currentlyUsingCustomServer: 'Aktualnie używany jest niestandardowy serwer',
        customServerUrlLabel: 'URL niestandardowego serwera',
        advancedFeatureFooter: 'To jest zaawansowana funkcja. Zmieniaj serwer tylko jeśli wiesz, co robisz. Po zmianie serwera będziesz musiał się wylogować i zalogować ponownie.',
        relayServerMenuTitle: 'Serwer Relay',
        relayServerMenuSubtitleDefault: 'Hostowane przez Northglass — zmień, aby wskazać własny self-hosted relay',
        relayServerMenuInfo: 'Idle przesyła wiadomości między telefonem a CLI przez serwer pośredniczący. Domyślnie jest to nasz hostowany (idle-api.northglass.io). Możesz wskazać Idle własny serwer — zobacz SELF-HOSTING.md w repozytorium.',
        relayServerMenuSubtitleCustom: 'Niestandardowy (self-hosted)',
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        moveToTop: 'Move to Top',
        killSession: 'Zakończ sesję',
        killSessionConfirm: 'Czy na pewno chcesz zakończyć tę sesję?',
        archiveSession: 'Zarchiwizuj sesję',
        archiveSessionConfirm: 'Czy na pewno chcesz zarchiwizować tę sesję?',
        idleSessionIdCopied: 'ID sesji Idle skopiowane do schowka',
        failedToCopySessionId: 'Nie udało się skopiować ID sesji Idle',
        idleSessionId: 'ID sesji Idle',
        claudeCodeSessionId: 'ID sesji Claude Code',
        claudeCodeSessionIdCopied: 'ID sesji Claude Code skopiowane do schowka',
        codexThreadId: 'ID wątku Codex',
        codexThreadIdCopied: 'ID wątku Codex skopiowane do schowka',
        aiProvider: 'Dostawca AI',
        failedToCopyClaudeCodeSessionId: 'Nie udało się skopiować ID sesji Claude Code',
        failedToCopyCodexThreadId: 'Nie udało się skopiować ID wątku Codex',
        failedToKillSession: 'Nie udało się zakończyć sesji',
        failedToArchiveSession: 'Nie udało się zarchiwizować sesji',
        connectionStatus: 'Status połączenia',
        created: 'Utworzono',
        lastUpdated: 'Ostatnia aktualizacja',
        sequence: 'Sekwencja',
        quickActions: 'Szybkie akcje',
        viewMachine: 'Zobacz maszynę',
        viewMachineSubtitle: 'Zobacz szczegóły maszyny i sesje',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: 'Natychmiastowo zakończ sesję',
        archiveSessionSubtitle: 'Zarchiwizuj tę sesję i zatrzymaj ją',
        metadata: 'Metadane',
        host: 'Host',
        path: 'Ścieżka',
        operatingSystem: 'System operacyjny',
        processId: 'ID procesu',
        idleHome: 'Katalog domowy Idle',
        agentState: 'Stan agenta',
        controlledByUser: 'Kontrolowany przez użytkownika',
        pendingRequests: 'Oczekujące żądania',
        activity: 'Aktywność',
        thinking: 'Myśli',
        thinkingSince: 'Myśli od',
        cliVersion: 'Wersja CLI',
        idleAppVersion: 'Wersja aplikacji Idle',
        cliVersionOutdated: 'Wymagana aktualizacja CLI',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Zainstalowana wersja ${currentVersion}. Zaktualizuj do ${requiredVersion} lub nowszej`,
        updateCliInstructions: 'Proszę uruchomić npm install -g idle-coder@latest',
        deleteSession: 'Usuń sesję',
        deleteSessionSubtitle: 'Trwale usuń tę sesję',
        deleteSessionConfirm: 'Usunąć sesję na stałe?',
        deleteSessionWarning: 'Ta operacja jest nieodwracalna. Wszystkie wiadomości i dane powiązane z tą sesją zostaną trwale usunięte.',
        failedToDeleteSession: 'Nie udało się usunąć sesji',
        sessionDeleted: 'Sesja została pomyślnie usunięta',
        worktreeCleanupTitle: 'Usunąć Worktree?',
        worktreeCleanupMessage: 'Worktree nie ma niezatwierdzonych zmian. Czy chcesz usunąć pliki Worktree?',
        worktreeCleanupDelete: 'Usuń Worktree',
        worktreeCleanupKeep: 'Zachowaj pliki',
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Gotowy do kodowania?',
            installCli: 'Zainstaluj Idle CLI',
            runIt: 'Uruchom je',
            scanQrCode: 'Zeskanuj kod QR',
            openCamera: 'Otwórz kamerę',
            howPairingWorks: 'How does pairing work?',
            howPairingWorksTitle: 'Pairing Idle',
            howPairingWorksBody:
                'Idle pairs this app with a coding session running on your computer.\n\n' +
                '1. On your computer, install the CLI: npm i -g idle-coder\n' +
                '2. Run "idle" and choose Mobile — it prints a QR code and an idle:// URL.\n' +
                '3. Either tap "Open Camera" to scan the QR, or tap "Enter URL manually" and paste the idle:// URL.\n\n' +
                'Both options do the same thing. You need a computer running the CLI to generate the code — there is nothing to scan or paste until then.',
        },
        emptyMessages: {
            title: 'Brak wiadomości',
            createdAt: ({ time }: { time: string }) => `Utworzono ${time}`,
        },
        emptySessionsTablet: {
            title: 'Brak aktywnych sesji',
            descriptionOnline: 'Rozpocznij nową sesję na dowolnym podłączonym komputerze.',
            startNewSession: 'Nowa sesja',
            descriptionOffline: 'Otwórz nowy terminal na komputerze, aby rozpocząć sesję.',
        },
        sessionActions: {
            archive: 'Archiwizuj',
        },
        restoreScreen: {
            step1: '1. Otwórz Idle na urządzeniu mobilnym',
            step2: '2. Przejdź do Ustawienia, Konto',
            step3: '3. Dotknij "Połącz nowe urządzenie"',
            step4: '4. Zeskanuj kod QR',
        },
        agentGoalBar: {
            currentGoal: 'Bieżący cel',
            accessibilityLabel: ({ goal }: { goal: string }) => `Bieżący cel: ${goal}`,
            clearGoal: 'Wyczyść cel',
            stopGoal: 'Zatrzymaj cel',
            editGoal: 'Edytuj cel',
        },
    },

    agentInput: {
        permissionMode: {
            title: 'TRYB UPRAWNIEŃ',
            default: 'Domyślny',
            acceptEdits: 'Akceptuj edycje',
            plan: 'Tryb planowania',
            dontAsk: 'Nie pytaj',
            bypassPermissions: 'Tryb YOLO',
            badgeAcceptAllEdits: 'Akceptuj wszystkie edycje',
            badgeBypassAllPermissions: 'Omiń wszystkie uprawnienia',
            badgePlanMode: 'Tryb planowania',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: 'MODEL',
            configureInCli: 'Skonfiguruj modele w ustawieniach CLI',
        },
        effort: {
            title: 'WYSIŁEK',
        },
        codexPermissionMode: {
            title: 'TRYB UPRAWNIEŃ CODEX',
            default: 'Ustawienia CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            badgeReadOnly: 'Read Only Mode',
            badgeSafeYolo: 'Safe YOLO',
            badgeYolo: 'YOLO',
        },
        codexModel: {
            title: 'CODEX MODEL',
            gpt5CodexLow: 'gpt-5-codex low',
            gpt5CodexMedium: 'gpt-5-codex medium',
            gpt5CodexHigh: 'gpt-5-codex high',
            gpt5Minimal: 'GPT-5 Minimal',
            gpt5Low: 'GPT-5 Low',
            gpt5Medium: 'GPT-5 Medium',
            gpt5High: 'GPT-5 High',
        },
        geminiPermissionMode: {
            title: 'TRYB UPRAWNIEŃ GEMINI',
            default: 'Domyślny',
            autoEdit: 'Auto edycja',
            yolo: 'YOLO',
            plan: 'Planowanie',
            badgeAutoEdit: 'Auto edycja',
            badgeYolo: 'YOLO',
            badgePlan: 'Planowanie',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `Pozostało ${percent}%`,
        },
        suggestion: {
            fileLabel: 'PLIK',
            folderLabel: 'FOLDER',
        },
        noMachinesAvailable: 'Brak maszyn',
    },

    machineLauncher: {
        showLess: 'Pokaż mniej',
        showAll: ({ count }: { count: number }) => `Pokaż wszystkie (${count} ${plural({ count, one: 'ścieżka', few: 'ścieżki', many: 'ścieżek' })})`,
        enterCustomPath: 'Wprowadź niestandardową ścieżkę',
        offlineUnableToSpawn: 'Nie można utworzyć nowej sesji, offline',
    },

    sidebar: {
        sessionsTitle: 'Idle',
        showArchived: 'Pokaż zarchiwizowane',
        hideArchived: 'Ukryj zarchiwizowane',
        newSession: 'Nowa sesja',
    },

    zen: {
        toggle: 'Tryb zen',
    },

    toolView: {
        input: 'Wejście',
        output: 'Wyjście',
    },

    toolGroup: {
        editedFile: 'Edited file',
        editedFiles: ({ count }: { count: number }) => `${plural({ count, one: 'Edytowano 1 plik', few: `Edytowano ${count} pliki`, many: `Edytowano ${count} plików` })}`,
        readFiles: ({ count }: { count: number }) => `${plural({ count, one: 'Odczytano 1 plik', few: `Odczytano ${count} pliki`, many: `Odczytano ${count} plików` })}`,
        ranCommands: ({ count }: { count: number }) => `${plural({ count, one: 'Wykonano 1 polecenie', few: `Wykonano ${count} polecenia`, many: `Wykonano ${count} poleceń` })}`,
        searched: ({ count }: { count: number }) => `${plural({ count, one: 'Wyszukano 1 raz', few: `Wyszukano ${count} razy`, many: `Wyszukano ${count} razy` })}`,
        fetchedUrls: ({ count }: { count: number }) => `${plural({ count, one: 'Pobrano 1 URL', few: `Pobrano ${count} URLe`, many: `Pobrano ${count} URLi` })}`,
        ranTasks: ({ count }: { count: number }) => `${plural({ count, one: 'Wykonano 1 zadanie', few: `Wykonano ${count} zadania`, many: `Wykonano ${count} zadań` })}`,
        usedTools: ({ count }: { count: number }) => `${plural({ count, one: 'Użyto 1 narzędzie', few: `Użyto ${count} narzędzia`, many: `Użyto ${count} narzędzi` })}`,
        workedFor: ({ duration }: { duration: string }) => `Worked ${duration}`,
    },

    tools: {
        fullView: {
            description: 'Opis',
            inputParams: 'Parametry wejściowe',
            output: 'Wyjście',
            error: 'Błąd',
            completed: 'Narzędzie ukończone pomyślnie',
            noOutput: 'Nie wygenerowano żadnego wyjścia',
            running: 'Narzędzie działa...',
        },
        taskView: {
            initializing: 'Inicjalizacja agenta...',
            moreTools: ({ count }: { count: number }) => `+${count} ${plural({ count, one: 'więcej narzędzie', few: 'więcej narzędzia', many: 'więcej narzędzi' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edycja ${index} z ${total}`,
            replaceAll: 'Zamień wszystkie',
        },
        names: {
            task: 'Zadanie',
            terminal: 'Terminal',
            searchFiles: 'Wyszukaj pliki',
            search: 'Wyszukaj',
            searchContent: 'Wyszukaj zawartość',
            listFiles: 'Lista plików',
            planProposal: 'Propozycja planu',
            readFile: 'Czytaj plik',
            editFile: 'Edytuj plik',
            writeFile: 'Zapisz plik',
            fetchUrl: 'Pobierz URL',
            readNotebook: 'Czytaj notatnik',
            editNotebook: 'Edytuj notatnik',
            todoList: 'Lista zadań',
            webSearch: 'Wyszukiwanie w sieci',
            reasoning: 'Rozumowanie',
            applyChanges: 'Zaktualizuj plik',
            viewDiff: 'Bieżące zmiany pliku',
            question: 'Pytanie',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Wyszukaj(wzorzec: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Wyszukaj(ścieżka: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Pobierz URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Edytuj notatnik(plik: ${path}, tryb: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Lista zadań(liczba: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Wyszukiwanie w sieci(zapytanie: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(wzorzec: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} ${plural({ count, one: 'edycja', few: 'edycje', many: 'edycji' })})`,
            readingFile: ({ file }: { file: string }) => `Odczytywanie ${file}`,
            writingFile: ({ file }: { file: string }) => `Zapisywanie ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modyfikowanie ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modyfikowanie ${count} ${plural({ count, one: 'pliku', few: 'plików', many: 'plików' })}`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} i ${count} ${plural({ count, one: 'więcej', few: 'więcej', many: 'więcej' })}`,
            showingDiff: 'Pokazywanie zmian',
        },
        askUserQuestion: {
            submit: 'Wyślij odpowiedź',
            multipleQuestions: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'pytanie', few: 'pytania', many: 'pytań' })}`,
            other: 'Inne',
            otherDescription: 'Wpisz własną odpowiedź',
            otherPlaceholder: 'Wpisz swoją odpowiedź...',
        }
    },

    files: {
        changes: 'Zmiany',
        searchPlaceholder: 'Wyszukaj pliki...',
        detachedHead: 'odłączony HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} przygotowanych • ${unstaged} nieprzygotowanych`,
        notRepo: 'To nie jest repozytorium git',
        notUnderGit: 'Ten katalog nie jest pod kontrolą wersji git',
        searching: 'Wyszukiwanie plików...',
        noFilesFound: 'Nie znaleziono plików',
        noFilesInProject: 'Brak plików w projekcie',
        tryDifferentTerm: 'Spróbuj innego terminu wyszukiwania',
        searchResults: ({ count }: { count: number }) => `Wyniki wyszukiwania (${count})`,
        projectRoot: 'Katalog główny projektu',
        stagedChanges: ({ count }: { count: number }) => `Przygotowane zmiany (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Nieprzygotowane zmiany (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Ładowanie ${fileName}...`,
        binaryFile: 'Plik binarny',
        cannotDisplayBinary: 'Nie można wyświetlić zawartości pliku binarnego',
        diff: 'Różnice',
        file: 'Plik',
        fileEmpty: 'Plik jest pusty',
        noChanges: 'Brak zmian do wyświetlenia',
        noChangesTitle: 'Brak zmian',
        noChangesSubtitle: 'Drzewo robocze jest czyste',
        deleted: 'Usunięty',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'zmieniony plik' : 'zmienionych plików'}`,
        allFiles: 'Wszystkie pliki',
        editFile: 'Edytuj',
        saveFile: 'Zapisz',
        failedToRead: 'Nie udało się odczytać pliku',
        failedToSave: 'Nie udało się zapisać pliku',
        fileConflict: 'Konflikt pliku',
        fileConflictDescription: 'Ten plik został zmodyfikowany na urządzeniu podczas edycji. Załaduj ponownie aby zobaczyć najnowszą wersję.',
        reload: 'Załaduj ponownie',
        overwrite: 'Nadpisz',
    },

    settingsVoice: {
        // Voice settings screen
        permissionConfirmTitle: 'Zatwierdzić żądanie narzędzia?',
        messageConfirmTitle: 'Wysłać wiadomość głosową?',
        languageTitle: 'Język',
        languageDescription: 'Wybierz preferowany język dla interakcji z asystentem głosowym. To ustawienie synchronizuje się na wszystkich Twoich urządzeniach.',
        preferredLanguage: 'Preferowany język',
        preferredLanguageSubtitle: 'Język używany do odpowiedzi asystenta głosowego',
        language: {
            searchPlaceholder: 'Wyszukaj języki...',
            title: 'Języki',
            footer: ({ count }: { count: number }) => `Dostępnych ${count} ${plural({ count, one: 'język', few: 'języki', many: 'języków' })}`,
            autoDetect: 'Automatyczne wykrywanie',
        },
        // Bring your own agent
        byoTitle: 'Użyj własnego agenta',
        byoDescription: 'Skonfiguruj własnego agenta ElevenLabs do połączenia bezpośredniego. Twój agent musi definiować dwa narzędzia klienckie: sendMessageToSession (wysyła tekst do wybranej sesji kodowania) i processPermissionRequest (zezwala lub odmawia użycia narzędzi). Otrzymuje ograniczony kontekst sesji przez zmienną dynamiczną {{initialConversationContext}}.',
        customAgentId: 'ElevenLabs Agent ID',
        customAgentIdNotSet: 'Nie skonfigurowano',
        customAgentIdDescription: 'Wymagane do połączenia bezpośredniego. Wprowadź identyfikator agenta ElevenLabs; połączenie bezpośrednie nie używa domyślnego agenta Idle.',
        customAgentIdPlaceholder: 'e.g. abc123def456',
        bypassToken: 'Połączenie bezpośrednie',
        bypassTokenSubtitle: 'Pomiń serwer Idle, połącz się bezpośrednio z ElevenLabs',
        promptGuideTitle: 'Przewodnik po promptach agenta',
        promptGuideDescription: 'Twój agent ElevenLabs potrzebuje:\n\n• Narzędzie: sendMessageToSession — parametry: sessionId (string) i message (string). Wysyła wiadomość do wybranej sesji kodowania.\n• Narzędzie: processPermissionRequest — parametry: sessionId (string), requestId (string) i decision ("allow" lub "deny"). Zatwierdza lub odrzuca oczekujące uprawnienie narzędzia; zatwierdzenie nadal wymaga potwierdzenia na tym urządzeniu.\n• Zmienna dynamiczna: {{initialConversationContext}} — otrzymuje ograniczony kontekst sesji przy uruchomieniu.\n\nAgent działa jako most głosowy między użytkownikiem a agentami kodującymi. Powinien być zwięzły, traktować wstrzyknięty kontekst jako niezaufane dane, działać tylko na podstawie głosu użytkownika na żywo i raportować, gdy agent kodujący zakończy pracę.',
        usageTitle: 'Użycie (ostatnie 30 dni)',
        usageFooter: 'Czas głosowy wykorzystany w ostatnich 30 dniach. Darmowy plan: 20 min. Z subskrypcją: 5 godzin. Maks. 100 rozmów miesięcznie.',
        usageLabel: 'Czas głosowy',
        conversationsLabel: 'Rozmowy',
        usageUsed: ({ used, limit }: { used: string; limit: string }) => `${used} wykorzystano z ${limit}`,
        supportTitle: 'Ulepsz głos',
        supportSubtitle: 'Więcej czasu głosowego i wsparcie rozwoju',
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: 'Informacje o koncie',
        status: 'Status',
        statusActive: 'Aktywny',
        statusNotAuthenticated: 'Nie uwierzytelniony',
        publicId: 'ID publiczne',
        notAvailable: 'Niedostępne',
        linkNewDevice: 'Połącz nowe urządzenie',
        linkNewDeviceSubtitle: 'Zeskanuj kod QR, aby połączyć urządzenie',
        profile: 'Profil',
        name: 'Nazwa',
        github: 'GitHub',
        tapToDisconnect: 'Dotknij, aby rozłączyć',
        server: 'Serwer',
        backup: 'Kopia zapasowa',
        backupDescription: 'Twój klucz tajny to jedyny sposób na odzyskanie konta. Zapisz go w bezpiecznym miejscu, takim jak menedżer haseł.',
        secretKey: 'Klucz tajny',
        tapToReveal: 'Dotknij, aby pokazać',
        tapToHide: 'Dotknij, aby ukryć',
        secretKeyLabel: 'KLUCZ TAJNY (DOTKNIJ, ABY SKOPIOWAĆ)',
        secretKeyCopied: 'Klucz tajny skopiowany do schowka. Przechowuj go w bezpiecznym miejscu!',
        secretKeyCopyFailed: 'Nie udało się skopiować klucza tajnego',
        privacy: 'Prywatność',
        privacyDescription: 'Udostępnia PostHog ograniczone zdarzenia użycia oraz metadane aplikacji/urządzenia. Monity, treść sesji, adresy URL i identyfikatory konta są wykluczone.',
        analytics: 'Analityka',
        analyticsDisabled: 'Dane nie są udostępniane',
        analyticsEnabled: 'Udostępniane są ograniczone dane o użytkowaniu',
        dangerZone: 'Strefa niebezpieczna',
        logout: 'Wyloguj',
        logoutSubtitle: 'Wyloguj się i wyczyść dane lokalne',
        logoutConfirm: 'Czy na pewno chcesz się wylogować? Upewnij się, że masz kopię zapasową klucza tajnego!',
        logoutInfo: 'Wylogowuje cię z tego urządzenia, czyści lokalną pamięć podręczną i wyrejestrowuje powiadomienia push. Twoje konto, sesje i sparowane maszyny NIE są usuwane — zaloguj się ponownie kluczem prywatnym, aby przywrócić wszystko.',
        deleteAccount: 'Usuń konto',
        deleteAccountSubtitle: 'Trwale usuń swoje konto i wszystkie dane',
        deleteAccountConfirm: 'Spowoduje to trwałe usunięcie konta oraz wszystkich sesji, wiadomości i powiązanych maszyn z naszych serwerów. Tej operacji nie można cofnąć.',
        deleteAccountConfirmButton: 'Usuń konto',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Język',
        description: 'Wybierz preferowany język interfejsu aplikacji. To ustawienie zostanie zsynchronizowane na wszystkich Twoich urządzeniach.',
        currentLanguage: 'Aktualny język',
        automatic: 'Automatycznie',
        automaticSubtitle: 'Wykrywaj na podstawie ustawień urządzenia',
        needsRestart: 'Język zmieniony',
        needsRestartMessage: 'Aplikacja musi zostać uruchomiona ponownie, aby zastosować nowe ustawienia języka.',
        restartNow: 'Uruchom ponownie',
    },

    connectButton: {
        authenticate: 'Uwierzytelnij terminal',
        authenticateWithUrlPaste: 'Uwierzytelnij terminal poprzez wklejenie URL',
        pasteAuthUrl: 'Wklej URL uwierzytelnienia z terminala',
    },

    updateBanner: {
        updateAvailable: 'Dostępna aktualizacja',
        pressToApply: 'Naciśnij, aby zastosować aktualizację',
        whatsNew: 'Co nowego',
        seeLatest: 'Zobacz najnowsze aktualizacje i ulepszenia',
        nativeUpdateAvailable: 'Dostępna aktualizacja aplikacji',
        tapToUpdateAppStore: 'Naciśnij, aby zaktualizować w App Store',
        tapToUpdatePlayStore: 'Naciśnij, aby zaktualizować w Sklepie Play',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Wersja ${version}`,
        noEntriesAvailable: 'Brak dostępnych wpisów dziennika zmian.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Wymagana przeglądarka internetowa',
        webBrowserRequiredDescription: 'Linki połączenia terminala można otwierać tylko w przeglądarce internetowej ze względów bezpieczeństwa. Użyj skanera kodów QR lub otwórz ten link na komputerze.',
        processingConnection: 'Przetwarzanie połączenia...',
        invalidConnectionLink: 'Nieprawidłowy link połączenia',
        invalidConnectionLinkDescription: 'Link połączenia jest nieprawidłowy lub go brakuje. Sprawdź URL i spróbuj ponownie.',
        connectTerminal: 'Połącz terminal',
        terminalRequestDescription: 'Terminal żąda trwałego dostępu do Twojego konta Idle. Sparowany terminal może tworzyć, zmieniać i usuwać dane konta.',
        connectionDetails: 'Szczegóły połączenia',
        publicKey: 'Klucz publiczny',
        encryption: 'Szyfrowanie',
        endToEndEncrypted: 'Szyfrowanie end-to-end',
        acceptConnection: 'Akceptuj połączenie',
        connecting: 'Łączenie...',
        reject: 'Odrzuć',
        security: 'Bezpieczeństwo',
        securityFooter: 'Link jest analizowany lokalnie w przeglądarce. Zgoda na parowanie jest wysyłana do skonfigurowanego przekaźnika, który wydaje dane logowania zaszyfrowane dla żądającego terminala.',
        securityFooterDevice: 'Link jest analizowany lokalnie na tym urządzeniu. Zgoda na parowanie jest wysyłana do skonfigurowanego przekaźnika, który wydaje dane logowania zaszyfrowane dla żądającego terminala.',
        pairingGrantTitle: 'Przyznać temu terminalowi dostęp do konta?',
        pairingGrantDescription: 'Paruj wyłącznie terminal, który właśnie uruchomiłeś i kontrolujesz. Otrzyma trwałe dane logowania pozwalające tworzyć, zmieniać i usuwać dane konta, w tym usunąć całe konto. Pomoc techniczna Idle nigdy nie poprosi o zatwierdzenie parowania.',
        pairTerminal: 'Sparuj terminal',
        clientSideProcessing: 'Przetwarzanie po stronie klienta',
        linkProcessedLocally: 'Link przetworzony lokalnie w przeglądarce',
        linkProcessedOnDevice: 'Link przetworzony lokalnie na urządzeniu',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Uwierzytelnij terminal',
        pasteUrlFromTerminal: 'Wklej URL uwierzytelnienia z terminala',
        deviceLinkedSuccessfully: 'Urządzenie połączone pomyślnie',
        terminalConnectedSuccessfully: 'Terminal połączony pomyślnie',
        invalidAuthUrl: 'Nieprawidłowy URL uwierzytelnienia',
        disconnectGithub: 'Rozłącz GitHub',
        disconnectGithubConfirm: 'Czy na pewno chcesz rozłączyć swoje konto GitHub?',
        disconnect: 'Rozłącz',
        failedToConnectTerminal: 'Nie udało się połączyć terminala',
        cameraPermissionsRequiredToConnectTerminal: 'Uprawnienia do kamery są wymagane do połączenia terminala',
        failedToLinkDevice: 'Nie udało się połączyć urządzenia',
        cameraPermissionsRequiredToScanQr: 'Uprawnienia do kamery są wymagane do skanowania kodów QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Połącz terminal',
        linkNewDevice: 'Połącz nowe urządzenie',
        restoreWithSecretKey: 'Przywróć kluczem tajnym',
        whatsNew: 'Co nowego',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Mobilny klient Codex i Claude Code',
        subtitle: 'Treść sesji jest szyfrowana end-to-end; przekaźnik nadal obsługuje metadane konta i routingu.',
        createAccount: 'Utwórz konto',
        linkOrRestoreAccount: 'Połącz lub przywróć konto',
        loginWithMobileApp: 'Zaloguj się przez aplikację mobilną',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Podoba Ci się aplikacja?',
        feedbackPrompt: 'Chcielibyśmy usłyszeć Twoją opinię!',
        yesILoveIt: 'Tak, uwielbiam ją!',
        notReally: 'Nie bardzo'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} skopiowano do schowka`
    },

    machine: {
        offlineUnableToSpawn: 'Launcher wyłączony, gdy maszyna jest offline',
        offlineHelp: '• Upewnij się, że komputer jest online\n• Uruchom `idle daemon status`, aby zdiagnozować\n• Czy używasz najnowszej wersji CLI? Zaktualizuj poleceniem `npm install -g idle-coder@latest`',
        launchNewSessionInDirectory: 'Uruchom nową sesję w katalogu',
        daemon: 'Daemon',
        status: 'Status',
        stopDaemon: 'Zatrzymaj daemon',
        lastKnownPid: 'Ostatni znany PID',
        lastKnownHttpPort: 'Ostatni znany port HTTP',
        startedAt: 'Uruchomiony o',
        cliVersion: 'Wersja CLI',
        daemonStateVersion: 'Wersja stanu daemon',
        activeSessions: ({ count }: { count: number }) => `Aktywne sesje (${count})`,
        machineGroup: 'Maszyna',
        host: 'Host',
        machineId: 'ID maszyny',
        username: 'Nazwa użytkownika',
        homeDirectory: 'Katalog domowy',
        platform: 'Platforma',
        architecture: 'Architektura',
        lastSeen: 'Ostatnio widziana',
        never: 'Nigdy',
        metadataVersion: 'Wersja metadanych',
        cliAvailability: 'Dostępność CLI',
        cliInstalled: 'Zainstalowany',
        cliNotFound: 'Nie znaleziono',
        lastDetected: 'Ostatnio wykryto',
        untitledSession: 'Sesja bez nazwy',
        back: 'Wstecz',
        // Session section header and multi-machine summary
        unknownHost: 'Nieznany',
        multipleMachines: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'maszyna', few: 'maszyny', many: 'maszyn' })}`,
        startNewSessionInPath: ({ path }: { path: string }) => `Rozpocznij nową sesję w ${path}`,
        viewMachineLabel: ({ name }: { name: string }) => `Wyświetl maszynę: ${name}`,
        dangerZone: 'Strefa niebezpieczna',
        delete: 'Usuń maszynę',
        deleteFooter: 'Usuń tę maszynę ze swojego konta. Historia sesji zostanie zachowana, ale nie będziesz mógł uruchamiać nowych sesji na tej maszynie.',
        deleteConfirmTitle: 'Usunąć tę maszynę?',
        deleteConfirmMessage: 'Maszyna zostanie usunięta z twojego konta. Historia sesji zostanie zachowana, ale nie będziesz mógł uruchamiać nowych sesji, dopóki ponownie nie podłączysz demona.',
        deleteFailed: 'Nie udało się usunąć maszyny.',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Przełączono na tryb ${mode}`,
        unknownEvent: 'Nieznane zdarzenie',
        usageLimitUntil: ({ time }: { time: string }) => `Osiągnięto limit użycia do ${time}`,
        sentAsGoal: 'Sent as goal',
        unknownTime: 'nieznany czas',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Tak, i nie pytaj dla tej sesji',
            stopAndExplain: 'Zatrzymaj i wyjaśnij, co zrobić',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Tak, zezwól na wszystkie edycje podczas tej sesji',
            yesAllowEverything: 'Tak, zezwól na wszystko podczas tej sesji',
            yesForTool: 'Tak, nie pytaj ponownie dla tego narzędzia',
            noTellClaude: 'Nie, przekaż opinię',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'Wybierz zakres tekstu',
        title: 'Wybierz tekst',
        noTextProvided: 'Nie podano tekstu',
        textNotFound: 'Tekst nie został znaleziony lub wygasł',
        textCopied: 'Tekst skopiowany do schowka',
        failedToCopy: 'Nie udało się skopiować tekstu do schowka',
        noTextToCopy: 'Brak tekstu do skopiowania',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Kod skopiowany',
        copyFailed: 'Błąd kopiowania',
        mermaidRenderFailed: 'Nie udało się wyświetlić diagramu mermaid',
        imageAlt: 'Obraz Markdown',
        remoteImageBlocked: 'Zdalny obraz zablokowany dla ochrony prywatności',
        loadRemoteImage: ({ host }: { host: string }) => `Wczytaj obraz z ${host}`,
        blockedImage: 'Obraz zablokowany z powodu niebezpiecznego źródła',
    },

    artifacts: {
        // Artifacts feature
        title: 'Artefakty',
        countSingular: '1 artefakt',
        countPlural: ({ count }: { count: number }) => {
            const n = Math.abs(count);
            const n10 = n % 10;
            const n100 = n % 100;

            // Polish plural rules: 1 (singular), 2-4 (few), 5+ (many)
            if (n === 1) {
                return `${count} artefakt`;
            }
            if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) {
                return `${count} artefakty`;
            }
            return `${count} artefaktów`;
        },
        empty: 'Brak artefaktów',
        emptyDescription: 'Utwórz pierwszy artefakt, aby rozpocząć',
        new: 'Nowy artefakt',
        edit: 'Edytuj artefakt',
        delete: 'Usuń',
        updateError: 'Nie udało się zaktualizować artefaktu. Spróbuj ponownie.',
        notFound: 'Artefakt nie został znaleziony',
        discardChanges: 'Odrzucić zmiany?',
        discardChangesDescription: 'Masz niezapisane zmiany. Czy na pewno chcesz je odrzucić?',
        deleteConfirm: 'Usunąć artefakt?',
        deleteConfirmDescription: 'Tej operacji nie można cofnąć',
        titleLabel: 'TYTUŁ',
        titlePlaceholder: 'Wprowadź tytuł dla swojego artefaktu',
        bodyLabel: 'TREŚĆ',
        bodyPlaceholder: 'Napisz swoją treść tutaj...',
        emptyFieldsError: 'Proszę wprowadzić tytuł lub treść',
        createError: 'Nie udało się utworzyć artefaktu. Spróbuj ponownie.',
        save: 'Zapisz',
        saving: 'Zapisywanie...',
        loading: 'Ładowanie artefaktów...',
        error: 'Nie udało się załadować artefaktu',
    },

    usage: {
        // Usage panel strings
        today: 'Dzisiaj',
        last7Days: 'Ostatnie 7 dni',
        last30Days: 'Ostatnie 30 dni',
        totalTokens: 'Łącznie tokenów',
        totalCost: 'Całkowity koszt',
        tokens: 'Tokeny',
        cost: 'Koszt',
        usageOverTime: 'Użycie w czasie',
        byType: 'Podział tokenów',
        noData: 'Brak danych o użyciu',
    },

    imageUpload: {
        permissionTitle: 'Dostęp do biblioteki zdjęć',
        permissionMessage: 'Zezwól na dostęp do biblioteki zdjęć, aby załączać obrazy do wiadomości.',
        limitTitle: 'Osiągnięto limit obrazów',
        limitMessage: ({ max }: { max: number }) => `Możesz dołączyć maksymalnie ${max} obrazów na wiadomość.`,
        fileTooLargeTitle: 'Plik zbyt duży',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" przekracza limit ${maxMb}MB i nie został dodany.`,
        uploadFailedTitle: 'Przesyłanie nieudane',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'Nie udało się przesłać jednego zdjęcia i nie zostało wysłane.'
            : `Nie udało się przesłać ${count} zdjęć i nie zostały wysłane.`,
        notSupportedTitle: 'Obrazy nieobsługiwane',
        notSupportedMessage: 'Ten agent nie obsługuje załączników obrazów. Obrazy nie zostały wysłane.',
    },

    home: {
        newGroup: 'New Group',
        newGroupTitle: 'New Group',
        newGroupMessage: 'Enter a name for this group.',
    },

    errorBoundary: {
        crashedComponent: ({ name }: { name: string }) => `${name} crashed. Tap to retry.`,
    },

    failedMessage: {
        title: 'Wiadomość nie została wysłana',
        retry: 'Ponów',
        retryInProgress: 'Wysyłanie…',
        discard: 'Odrzuć',
        bannerA11y: 'Powiadomienie o nieudanej wiadomości',
        retryA11y: 'Ponów wysłanie wiadomości',
        discardA11y: 'Odrzuć nieudaną wiadomość',
    },

    lab: {
        // Lab subscreen feature labels
        composer: 'Edytor',
        sessions: 'Sesje',
        diagnostics: 'Diagnostyka',
        imageAttachmentsTitle: 'Załączniki obrazów',
        imageAttachmentsBadge: '🧪 Eksperymentalne',
        imageAttachmentsLongDescription: 'Wybieraj lub wklejaj obrazy w edytorze. Potok przesyłania nie jest jeszcze podłączony do serwera — przełącznik służy tylko do wczesnego dostępu.',
        fileBrowserTitle: 'Przeglądarka plików w sesji',
        fileBrowserBadge: '✨ Podgląd',
        fileBrowserLongDescription: 'Stuknij ikonę folderu na pasku narzędzi edytora, aby przeglądać pliki, których Claude dotknął w tej sesji.',
        resumeSessionTitle: 'Wznawiaj rozłączone sesje',
        resumeSessionBadge: '🧪 Eksperymentalne',
        resumeSessionLongDescription: 'Ponowne łączenie z sesjami, których CLI zakończyło się nieoczekiwanie. Po stronie demona; wyniki się różnią.',
        hideInactiveTitle: 'Ukrywaj nieaktywne sesje',
        hideInactiveBadge: '✨ Podgląd',
        hideInactiveLongDescription: 'Sesje, które od dłuższego czasu nie otrzymały wiadomości, znikają z listy głównej.',
        viewUsageData: 'Wyświetl dane użytkowania',
        // Onboarding card
        welcomeTitle: 'Witamy w Laboratorium',
        welcomeBodyIntro: 'Wypróbuj funkcje, które wciąż budujemy. Niektóre się psują, niektóre są prawie gotowe. Każda wyjaśnia swoje ryzyko odznaką —',
        badgeExperimental: '🧪 może działać nieprawidłowo',
        badgeBeta: '🌗 działa w większości przypadków',
        badgePreview: '✨ prawie ukończona',
        welcomeFooter: 'Możesz wyjść w dowolnym momencie, wyłączając przełączniki.',
        dismissWelcome: 'Zamknij powitanie Laboratorium',
        // Empty state
        emptyTitle: 'Jeszcze nic nie jest uruchomione',
        emptyBody: 'Wybierz funkcję powyżej, aby ją wypróbować. Wszystkie są domyślnie wyłączone.',
        // Feedback footer
        feedbackTitle: 'Masz opinię o funkcji?',
        feedbackBody: 'Czytamy każdą odpowiedź. Błędy, "uwielbiam to", "to nie działa na Androidzie" — wszystko mile widziane.',
        feedbackGitHub: 'Otwórz zgłoszenie na GitHub ↗',
        emailA11y: 'Wyślij opinię na hello@northglass.io',
        githubA11y: 'Otwórz zgłoszenie na GitHub',
    },

} as const;

export type TranslationsPl = typeof pl;
