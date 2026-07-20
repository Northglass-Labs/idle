import type { TranslationStructure } from '../_default';

/**
 * Russian plural helper function
 * Russian has 3 plural forms: one, few, many
 * @param options - Object containing count and the three plural forms
 * @returns The appropriate form based on Russian plural rules
 */
function plural({ count, one, few, many }: { count: number; one: string; few: string; many: string }): string {
    const n = Math.abs(count);
    const n10 = n % 10;
    const n100 = n % 100;

    // Rule: ends in 1 but not 11
    if (n10 === 1 && n100 !== 11) return one;

    // Rule: ends in 2-4 but not 12-14
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;

    // Rule: everything else (0, 5-9, 11-19, etc.)
    return many;
}

/**
 * Russian translations for the Idle app
 * Must match the exact structure of the English translations
 */
export const ru: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        sessions: 'Терминалы',
        settings: 'Настройки',
    },

    common: {
        // Simple string constants
        cancel: 'Отмена',
        done: 'Done',
        authenticate: 'Авторизация',
        save: 'Сохранить',
        saveAs: 'Сохранить как',
        error: 'Ошибка',
        success: 'Успешно',
        ok: 'ОК',
        continue: 'Продолжить',
        back: 'Назад',
        create: 'Создать',
        rename: 'Переименовать',
        reset: 'Сбросить',
        logout: 'Выйти',
        yes: 'Да',
        no: 'Нет',
        discard: 'Отменить',
        version: 'Версия',
        copied: 'Скопировано',
        copy: 'Копировать',
        scanning: 'Сканирование...',
        urlPlaceholder: 'https://example.com',
        home: 'Главная',
        message: 'Сообщение',
        files: 'Файлы',
        fileViewer: 'Просмотр файла',
        loading: 'Загрузка...',
        retry: 'Повторить',
        delete: 'Удалить',
        optional: 'необязательно',
        moreActions: 'Другие действия',
        dismissHint: 'Скрыть подсказку',
    },

    connect: {
        restoreAccount: 'Восстановить аккаунт',
        enterSecretKey: 'Пожалуйста, введите секретный ключ',
        invalidSecretKey: 'Неверный секретный ключ. Проверьте и попробуйте снова.',
        enterUrlManually: 'Ввести URL вручную',
        enterUrlManuallyInfo: 'Используйте это, когда не можете отсканировать QR — скопируйте URL idle:// из вывода терминала и вставьте сюда. Тот же эффект, что и сканирование.',
    },

    settings: {
        title: 'Настройки',
        connectedAccounts: 'Подключенные аккаунты',
        connectAccount: 'Подключить аккаунт',
        github: 'GitHub',
        machines: 'Машины',
        showOfflineMachines: ({ count }: { count: number }) => {
            const lastTwo = count % 100;
            const lastOne = count % 10;
            if (lastTwo >= 11 && lastTwo <= 14) return `Показать ${count} оффлайн-машин`;
            if (lastOne === 1) return `Показать ${count} оффлайн-машину`;
            if (lastOne >= 2 && lastOne <= 4) return `Показать ${count} оффлайн-машины`;
            return `Показать ${count} оффлайн-машин`;
        },
        hideOfflineMachines: 'Скрыть оффлайн-машины',
        features: 'Функции',
        account: 'Аккаунт',
        accountSubtitle: 'Управление учётной записью',
        appearance: 'Внешний вид',
        appearanceSubtitle: 'Настройка внешнего вида приложения',
        voiceAssistant: 'Голосовой ассистент',
        voiceAssistantSubtitle: 'Настройка предпочтений голосового взаимодействия',
        voiceAssistantInfo: 'Пока голосовая функция активна, Idle отправляет в ElevenLabs аудио, названия и сводки активных сессий, обновления расшифровки текущей и относящихся к ней фоновых сессий, непрозрачные идентификаторы сессий и запросов, а также названия инструментов для запросов разрешений, необходимые для управления несколькими сессиями. Idle не добавляет отдельно сохраненные пути проектов или аргументы запросов разрешений. Сам текст расшифровки может содержать конфиденциальные данные. Оставьте голосовую функцию выключенной, чтобы не отправлять эти данные в ElevenLabs.',
        featuresTitle: 'Возможности',
        featuresSubtitle: 'Включить или отключить функции приложения',
        developer: 'Разработчик',
        about: 'О программе',
        aboutFooter: 'Idle — мобильный клиент для Codex и Claude Code. Содержимое сессий защищено сквозным шифрованием. Ретранслятор хранит метаданные аккаунта, маршрутизации и работы, необходимые для синхронизации; ключи аккаунта остаются на авторизованных устройствах. Не связано с Anthropic.',
        whatsNew: 'Что нового',
        whatsNewSubtitle: 'Посмотреть последние обновления и улучшения',
        reportIssue: 'Сообщить о проблеме',
        privacyPolicy: 'Политика конфиденциальности',
        termsOfService: 'Условия использования',
        eula: 'EULA',
        supportUs: 'Поддержите нас',
        supportUsSubtitlePro: 'Спасибо за вашу поддержку!',
        supportUsSubtitle: 'Поддержать разработку проекта',
        scanQrCodeToAuthenticate: 'Отсканируйте QR-код для авторизации',
        scanQrInfo: 'Сопряжение позволяет вашему телефону отправлять сообщения сессии Claude Code на вашем компьютере. QR содержит одноразовый ключ, который разрешает этому устройству управлять терминалом.',
        githubConnected: ({ login }: { login: string }) => `Подключен как @${login}`,
        githubInfo: 'Используется для входа через GitHub и для получения метаданных репозиториев в некоторых сценариях. Отключение удаляет только доступ к GitHub — ваш аккаунт Idle остаётся.',
        connectGithubAccount: 'Подключить аккаунт GitHub',
        usage: 'Использование',
        usageSubtitle: 'Просмотр использования API и затрат',
        // Dynamic settings messages
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} ${status === 'online' ? 'online' : 'offline'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'включена' : 'отключена'}`,
        // Settings section titles and menu rows
        sectionPairTerminal: 'Сопряжение терминала',
        sectionConnected: 'Подключено',
        sectionApp: 'Приложение',
        sectionAdvanced: 'Дополнительно',
        sectionHelp: 'Помощь и обратная связь',
        language: 'Язык',
        languageSubtitle: 'Выберите предпочтительный язык интерфейса',
        claudeCode: 'Агенты программирования',
        claudeCodeInfo: 'Claude Code, Codex и Gemini проходят аутентификацию на связанном компьютере через официальные CLI. Idle никогда не хранит эти учётные данные провайдеров.',
        labFeatures: 'Функции Лаборатории',
        labFeaturesSubtitle: 'Попробуйте экспериментальные функции в разработке',
        labFeaturesInfo: 'Экспериментальные переключатели. Они могут измениться, сломаться или быть удалены в будущих обновлениях. Безопасно пробовать, но не полагайтесь на них в долгосрочной перспективе.',
    },

    settingsAppearance: {
        commitAttribution: 'Commit attribution',
        commitAttributionDescription: 'Credit Idle in commits made through the app',
        commitAttributionInfo: 'When on, commits made through Idle add a "Co-Authored-By: Idle" credit (alongside Claude\'s). Off by default, so your commit history stays clean unless you opt in.',
        // Appearance settings screen
        theme: 'Тема',
        themeDescription: 'Выберите предпочтительную цветовую схему',
        themeOptions: {
            adaptive: 'Адаптивная',
            light: 'Светлая',
            dark: 'Тёмная',
        },
        themeDescriptions: {
            adaptive: 'Следовать настройкам системы',
            light: 'Всегда использовать светлую тему',
            dark: 'Всегда использовать тёмную тему',
        },
        display: 'Отображение',
        displayDescription: 'Управление макетом и интервалами',
        inlineToolCalls: 'Встроенные вызовы инструментов',
        inlineToolCallsDescription: 'Отображать вызовы инструментов прямо в сообщениях чата',
        expandTodoLists: 'Развернуть списки задач',
        expandTodoListsDescription: 'Показывать все задачи вместо только изменений',
        showLineNumbersInDiffs: 'Показывать номера строк в различиях',
        showLineNumbersInDiffsDescription: 'Отображать номера строк в различиях кода',
        showLineNumbersInToolViews: 'Показывать номера строк в представлениях инструментов',
        showLineNumbersInToolViewsDescription: 'Отображать номера строк в различиях представлений инструментов',
        wrapLinesInDiffs: 'Перенос строк в различиях',
        wrapLinesInDiffsDescription: 'Переносить длинные строки вместо горизонтальной прокрутки в представлениях различий',
        diffStyle: 'Вид сравнения',
        diffStyleDescription: 'Показывать различия в одну колонку (unified) или рядом (split). Режим split доступен только на web.',
        diffStyleOptions: {
            unified: 'Unified',
            split: 'Split',
        },
        alwaysShowContextSize: 'Всегда показывать размер контекста',
        alwaysShowContextSizeDescription: 'Отображать использование контекста даже когда не близко к лимиту',
        avatarStyle: 'Стиль аватара',
        avatarStyleDescription: 'Выберите внешний вид аватара сессии',
        avatarOptions: {
            pixelated: 'Пиксельная',
            gradient: 'Градиентная',
            brutalist: 'Бруталистская',
            northglass: 'Northglass',
        },
        showFlavorIcons: 'Показывать иконки провайдеров ИИ',
        showFlavorIconsDescription: 'Отображать иконки провайдеров ИИ на аватарах сессий',
        showMessageTimestamps: 'Show Message Timestamps',
        showMessageTimestampsDescription: 'Display timestamps under chat bubbles and on session rows',
        compactSessionView: 'Компактный вид сессий',
        compactSessionViewDescription: 'Отображать активные сессии в более компактном виде',
        linksOpenIn: 'Открывать ссылки в',
        linksOpenInDescription: 'Выберите, где открываются ссылки при нажатии',
        linksOpenInOptions: {
            'in-app': 'Встроенный браузер',
            'external': 'Внешний браузер',
        },
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Эксперименты',
        experimentsDescription: 'Включить экспериментальные функции, которые всё ещё разрабатываются. Эти функции могут быть нестабильными или изменяться без предупреждения.',
        experimentalFeatures: 'Экспериментальные функции',
        experimentalFeaturesEnabled: 'Экспериментальные функции включены',
        experimentalFeaturesDisabled: 'Используются только стабильные функции',
        webFeatures: 'Веб-функции',
        webFeaturesDescription: 'Функции, доступные только в веб-версии приложения.',
        enterToSend: 'Enter для отправки',
        enterToSendEnabled: 'Нажмите Enter для отправки (Shift+Enter для новой строки)',
        enterToSendDisabled: 'Enter вставляет новую строку',
        commandPalette: 'Command Palette',
        commandPaletteEnabled: 'Нажмите ⌘K для открытия',
        commandPaletteDisabled: 'Быстрый доступ к командам отключён',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Долгое нажатие открывает модальное окно копирования',
        hideInactiveSessions: 'Скрывать неактивные сессии',
        hideInactiveSessionsSubtitle: 'Показывать в списке только активные чаты',
        groupToolCalls: 'Группировать вызовы инструментов',
        groupToolCallsSubtitle: 'Сворачивать подряд идущие вызовы инструментов в один блок',
        privacy: 'Конфиденциальность',
        privacyDescription: 'Полностью отключает всю аналитику и телеметрию. Никакие данные не будут отправляться в PostHog или другие сервисы отслеживания.',
        disableAnalytics: 'Отключить аналитику',
        analyticsDisabled: 'Вся аналитика и телеметрия отключены',
        analyticsEnabled: 'Необязательная аналитика использования активна',
        imageUpload: 'Загрузка изображений',
        imageUploadSubtitle: 'Прикрепляйте изображения к сообщениям для анализа поддерживаемыми агентами',
    },

    errors: {
        networkError: 'Произошла ошибка сети',
        serverError: 'Произошла ошибка сервера',
        unknownError: 'Произошла неизвестная ошибка',
        connectionTimeout: 'Время соединения истекло',
        authenticationFailed: 'Ошибка авторизации',
        permissionDenied: 'Доступ запрещен',
        fileNotFound: 'Файл не найден',
        invalidFormat: 'Неверный формат',
        operationFailed: 'Операция не выполнена',
        tryAgain: 'Пожалуйста, попробуйте снова',
        contactSupport: 'Если проблема сохранится, обратитесь в поддержку',
        sessionNotFound: 'Сессия не найдена',
        voiceSessionFailed: 'Не удалось запустить голосовую сессию',
        voiceServiceUnavailable: 'Голосовой сервис временно недоступен',
        voiceLimitReachedTitle: 'Лимит голоса достигнут',
        voiceHardLimitReached: ({ hours }: { hours: number }) => `Вы использовали ${hours}+ часов голосового общения в этом месяце. Это максимально допустимый лимит. Голос снова станет доступен после сброса месячного лимита.`,
        voiceConversationLimitReached: 'Вы достигли максимального количества голосовых разговоров в этом месяце. Голос снова станет доступен после сброса месячного лимита разговоров.',
        sessionDeleted: 'Сессия была удалена',
        sessionDeletedDescription: 'Эта сессия была окончательно удалена',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} должно быть от ${min} до ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Повторить через ${seconds} ${plural({ count: seconds, one: 'секунду', few: 'секунды', many: 'секунд' })}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Ошибка ${code})`,
    },

    newSession: {
        title: 'Начать новую сессию',
        machineOffline: 'Машина недоступна',
        switchMachinesHint: '• Переключите машину, нажав на неё выше',
    },

    sessionHistory: {
        // Used by session history screen
        title: 'История сессий',
        empty: 'Сессии не найдены',
        today: 'Сегодня',
        yesterday: 'Вчера',
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'день', few: 'дня', many: 'дней' })} назад`,
        viewAll: 'Посмотреть все сессии',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'Настройка сервера',
        enterServerUrl: 'Пожалуйста, введите URL сервера',
        notValidIdleServer: 'Это не валидный сервер Idle',
        changeServer: 'Изменить сервер',
        continueWithServer: 'Продолжить с этим сервером?',
        resetToDefault: 'Сбросить по умолчанию',
        resetServerDefault: 'Сбросить сервер по умолчанию?',
        validating: 'Проверка...',
        validatingServer: 'Проверка сервера...',
        serverReturnedError: 'Сервер вернул ошибку',
        failedToConnectToServer: 'Не удалось подключиться к серверу',
        currentlyUsingCustomServer: 'Сейчас используется пользовательский сервер',
        customServerUrlLabel: 'URL пользовательского сервера',
        advancedFeatureFooter: 'Это расширенная функция. Изменяйте сервер только если знаете, что делаете. Вам нужно будет выйти и войти снова после изменения серверов.',
        relayServerMenuTitle: 'Сервер Relay',
        relayServerMenuSubtitleDefault: 'Размещён Northglass — измените, чтобы указать на свой self-hosted relay',
        relayServerMenuInfo: 'Idle передаёт сообщения между телефоном и CLI через сервер ретрансляции. По умолчанию это наш хостируемый (idle-api.northglass.io). Вы можете указать Idle на свой сервер — см. SELF-HOSTING.md в репозитории.',
        relayServerMenuSubtitleCustom: 'Пользовательский (self-hosted)',
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        moveToTop: 'Move to Top',
        killSession: 'Завершить сессию',
        killSessionConfirm: 'Вы уверены, что хотите завершить эту сессию?',
        archiveSession: 'Архивировать сессию',
        archiveSessionConfirm: 'Вы уверены, что хотите архивировать эту сессию?',
        idleSessionIdCopied: 'ID сессии Idle скопирован в буфер обмена',
        failedToCopySessionId: 'Не удалось скопировать ID сессии Idle',
        idleSessionId: 'ID сессии Idle',
        claudeCodeSessionId: 'ID сессии Claude Code',
        claudeCodeSessionIdCopied: 'ID сессии Claude Code скопирован в буфер обмена',
        codexThreadId: 'ID треда Codex',
        codexThreadIdCopied: 'ID треда Codex скопирован в буфер обмена',
        aiProvider: 'Поставщик ИИ',
        failedToCopyClaudeCodeSessionId: 'Не удалось скопировать ID сессии Claude Code',
        failedToCopyCodexThreadId: 'Не удалось скопировать ID треда Codex',
        failedToKillSession: 'Не удалось завершить сессию',
        failedToArchiveSession: 'Не удалось архивировать сессию',
        connectionStatus: 'Статус подключения',
        created: 'Создано',
        lastUpdated: 'Последнее обновление',
        sequence: 'Последовательность',
        quickActions: 'Быстрые действия',
        viewMachine: 'Посмотреть машину',
        viewMachineSubtitle: 'Посмотреть детали машины и сессии',
        resumeSession: 'Resume Session',
        resumeSessionSubtitle: 'Resume this session on the same machine',
        resumeSessionSameMachineOnly: 'This session can only be resumed on the same machine it started on.',
        resumeSessionMachineOffline: 'This machine is offline. Resume is only available while it is online.',
        resumeSessionMissingMachine: 'This session is missing its machine metadata, so it cannot be resumed.',
        resumeSessionMissingBackendId: 'This session does not have a resumable Claude or Codex identifier.',
        resumeSessionUnexpectedDirectoryPrompt: 'Resume cannot create directories. Start the session manually from its original path.',
        killSessionSubtitle: 'Немедленно завершить сессию',
        archiveSessionSubtitle: 'Архивировать эту сессию и остановить её',
        metadata: 'Метаданные',
        host: 'Хост',
        path: 'Путь',
        operatingSystem: 'Операционная система',
        processId: 'ID процесса',
        idleHome: 'Домашний каталог Idle',
        agentState: 'Состояние агента',
        controlledByUser: 'Управляется пользователем',
        pendingRequests: 'Ожидающие запросы',
        activity: 'Активность',
        thinking: 'Думает',
        thinkingSince: 'Думает с',
        cliVersion: 'Версия CLI',
        idleAppVersion: 'Версия приложения Idle',
        cliVersionOutdated: 'Требуется обновление CLI',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Установлена версия ${currentVersion}. Обновите до ${requiredVersion} или новее`,
        updateCliInstructions: 'Пожалуйста, выполните npm install -g idle-coder@latest',
        deleteSession: 'Удалить сессию',
        deleteSessionSubtitle: 'Удалить эту сессию навсегда',
        deleteSessionConfirm: 'Удалить сессию навсегда?',
        deleteSessionWarning: 'Это действие нельзя отменить. Все сообщения и данные, связанные с этой сессией, будут удалены навсегда.',
        failedToDeleteSession: 'Не удалось удалить сессию',
        sessionDeleted: 'Сессия успешно удалена',
        worktreeCleanupTitle: 'Удалить Worktree?',
        worktreeCleanupMessage: 'В Worktree нет незафиксированных изменений. Хотите удалить файлы Worktree?',
        worktreeCleanupDelete: 'Удалить Worktree',
        worktreeCleanupKeep: 'Сохранить файлы',
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Готовы к программированию?',
            installCli: 'Установите Idle CLI',
            runIt: 'Запустите его',
            scanQrCode: 'Отсканируйте QR-код',
            openCamera: 'Открыть камеру',
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
            title: 'Нет сообщений',
            createdAt: ({ time }: { time: string }) => `Создано ${time}`,
        },
        emptySessionsTablet: {
            title: 'Нет активных сессий',
            descriptionOnline: 'Начните новую сессию на любом из подключённых компьютеров.',
            startNewSession: 'Новая сессия',
            descriptionOffline: 'Откройте новый терминал на вашем компьютере, чтобы начать сессию.',
        },
        sessionActions: {
            archive: 'Архивировать',
        },
        restoreScreen: {
            step1: '1. Откройте Idle на мобильном устройстве',
            step2: '2. Перейдите в Настройки, Аккаунт',
            step3: '3. Нажмите «Привязать новое устройство»',
            step4: '4. Отсканируйте QR-код',
        },
        agentGoalBar: {
            currentGoal: 'Текущая цель',
            accessibilityLabel: ({ goal }: { goal: string }) => `Текущая цель: ${goal}`,
            clearGoal: 'Очистить цель',
            stopGoal: 'Остановить цель',
            editGoal: 'Изменить цель',
        },
    },

    profile: {
        userProfile: 'Профиль пользователя',
        details: 'Детали',
        firstName: 'Имя',
        lastName: 'Фамилия',
        username: 'Имя пользователя',
        status: 'Статус',
    },


    status: {
        connected: 'подключено',
        connecting: 'подключение',
        disconnected: 'отключено',
        error: 'ошибка',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `в сети ${time}`,
        permissionRequired: 'требуется разрешение',
        activeNow: 'Активен сейчас',
        unknown: 'неизвестно',
        unread: 'новые результаты',
    },

    time: {
        justNow: 'только что',
        minutesAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'минуту', few: 'минуты', many: 'минут' })} назад`,
        hoursAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'час', few: 'часа', many: 'часов' })} назад`,
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'день', few: 'дня', many: 'дней' })} назад`,
    },

    session: {
        inputPlaceholder: 'Введите сообщение...',
        inputPlaceholderResume: 'Отправьте сообщение, чтобы возобновить сессию',
        inactiveArchived: 'Эта сессия неактивна.',
        resumeFromTerminal: 'Чтобы возобновить её из терминала:',
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
        archiveMovedToast: 'Архивирование перенесено в ⋯',
        actionsHintTip: 'Нажмите ⋯ на любой сессии для переименования, архивирования или перестановки.',
        newChat: 'Новый чат',
        forkAction: 'Форкнуть сессию',
        forkSubtitle: 'Продолжить в новой сессии с тем же контекстом',
        duplicateAction: 'Откатиться к сообщению…',
        duplicateSubtitle: 'Вернуться к выбранной точке и попробовать иначе',
        forkFromHere: 'Форкнуть отсюда',
        duplicateSheetTitle: 'Выберите точку отката',
        duplicateSheetSubtitle: 'Новая сессия сохранит выбранный ход целиком (ваше сообщение и ответ агента) и отбросит все следующие запросы.',
        duplicateSheetConfirm: 'Откатить',
        duplicateSheetEmpty: 'В этой сессии пока нет сообщений, к которым можно откатиться.',
        duplicateRowDisabled: 'К этому сообщению нельзя откатиться.',
        forkedFromLabel: 'Форкнуто из',
        forkedFromSubtitle: 'Открыть исходную сессию, из которой сделан форк',
        forkErrorOffline: 'Машина оффлайн. Форк доступен, только пока машина с сессией онлайн.',
        forkErrorMissingUuid: 'Выбранная точка отката больше не существует в исходной сессии — попробуйте форк без обрезки.',
        forkErrorMissingMetadata: 'Не хватает метаданных сессии для форка.',
        forkErrorGeneric: 'Не удалось форкнуть сессию.',
        forkClaudeOnly: 'Форк сейчас поддерживается только для Claude-сессий.',
    },

    commandPalette: {
        placeholder: 'Введите команду или поиск...',
    },

    agentInput: {
        permissionMode: {
            title: 'РЕЖИМ РАЗРЕШЕНИЙ',
            default: 'По умолчанию',
            acceptEdits: 'Принимать правки',
            plan: 'Режим планирования',
            dontAsk: 'Не спрашивать',
            bypassPermissions: 'YOLO режим',
            badgeAcceptAllEdits: 'Принимать все правки',
            badgeBypassAllPermissions: 'Обход всех разрешений',
            badgePlanMode: 'Режим планирования',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
            openclaw: 'OpenClaw',
        },
        model: {
            title: 'МОДЕЛЬ',
            configureInCli: 'Настройте модели в настройках CLI',
        },
        effort: {
            title: 'УСИЛИЕ',
        },
        codexPermissionMode: {
            title: 'РЕЖИМ РАЗРЕШЕНИЙ CODEX',
            default: 'Настройки CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            badgeReadOnly: 'Только чтение',
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
            title: 'РЕЖИМ РАЗРЕШЕНИЙ',
            default: 'По умолчанию',
            autoEdit: 'Авто-редактирование',
            yolo: 'YOLO',
            plan: 'Планирование',
            badgeAutoEdit: 'Авто-редактирование',
            badgeYolo: 'YOLO',
            badgePlan: 'Планирование',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `Осталось ${percent}%`,
        },
        suggestion: {
            fileLabel: 'ФАЙЛ',
            folderLabel: 'ПАПКА',
        },
        noMachinesAvailable: 'Нет машин',
    },

    machineLauncher: {
        showLess: 'Показать меньше',
        showAll: ({ count }: { count: number }) => `Показать все (${count} ${plural({ count, one: 'путь', few: 'пути', many: 'путей' })})`,
        enterCustomPath: 'Ввести свой путь',
        offlineUnableToSpawn: 'Невозможно создать сессию, машина offline',
    },

    sidebar: {
        sessionsTitle: 'Idle',
        showArchived: 'Показать архив',
        hideArchived: 'Скрыть архив',
        newSession: 'Новая сессия',
    },

    zen: {
        toggle: 'Дзен-режим',
    },

    toolView: {
        input: 'Входные данные',
        output: 'Результат',
    },

    toolGroup: {
        editedFile: 'Отредактированный файл',
        editedFiles: ({ count }: { count: number }) => `${plural({ count, one: 'Отредактирован', few: 'Отредактировано', many: 'Отредактировано' })} ${count} ${plural({ count, one: 'файл', few: 'файла', many: 'файлов' })}`,
        readFiles: ({ count }: { count: number }) => `${plural({ count, one: 'Прочитан', few: 'Прочитано', many: 'Прочитано' })} ${count} ${plural({ count, one: 'файл', few: 'файла', many: 'файлов' })}`,
        ranCommands: ({ count }: { count: number }) => `${plural({ count, one: 'Выполнена', few: 'Выполнено', many: 'Выполнено' })} ${count} ${plural({ count, one: 'команда', few: 'команды', many: 'команд' })}`,
        searched: ({ count }: { count: number }) => `${plural({ count, one: 'Выполнен', few: 'Выполнено', many: 'Выполнено' })} ${count} ${plural({ count, one: 'поиск', few: 'поиска', many: 'поисков' })}`,
        fetchedUrls: ({ count }: { count: number }) => `${plural({ count, one: 'Загружен', few: 'Загружено', many: 'Загружено' })} ${count} URL`,
        ranTasks: ({ count }: { count: number }) => `${plural({ count, one: 'Выполнена', few: 'Выполнено', many: 'Выполнено' })} ${count} ${plural({ count, one: 'задача', few: 'задачи', many: 'задач' })}`,
        usedTools: ({ count }: { count: number }) => `${plural({ count, one: 'Использован', few: 'Использовано', many: 'Использовано' })} ${count} ${plural({ count, one: 'инструмент', few: 'инструмента', many: 'инструментов' })}`,
        workedFor: ({ duration }: { duration: string }) => `Работало ${duration}`,
    },

    tools: {
        fullView: {
            description: 'Описание',
            inputParams: 'Входные параметры',
            output: 'Результат',
            error: 'Ошибка',
            completed: 'Инструмент выполнен успешно',
            noOutput: 'Результат не получен',
            running: 'Выполняется...',
        },
        taskView: {
            initializing: 'Инициализация агента...',
            moreTools: ({ count }: { count: number }) => `+${count} ещё ${plural({ count, one: 'инструмент', few: 'инструмента', many: 'инструментов' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Правка ${index} из ${total}`,
            replaceAll: 'Заменить все',
        },
        names: {
            task: 'Задача',
            terminal: 'Терминал',
            searchFiles: 'Поиск файлов',
            search: 'Поиск',
            searchContent: 'Поиск содержимого',
            listFiles: 'Список файлов',
            planProposal: 'Предложение плана',
            readFile: 'Чтение файла',
            editFile: 'Редактирование файла',
            writeFile: 'Запись файла',
            fetchUrl: 'Получение URL',
            readNotebook: 'Чтение блокнота',
            editNotebook: 'Редактирование блокнота',
            todoList: 'Список задач',
            webSearch: 'Веб-поиск',
            reasoning: 'Рассуждение',
            applyChanges: 'Обновить файл',
            viewDiff: 'Текущие изменения файла',
            question: 'Вопрос',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Терминал(команда: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Поиск(шаблон: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Поиск(путь: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Получение URL(адрес: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Редактирование блокнота(файл: ${path}, режим: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Список задач(количество: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Веб-поиск(запрос: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(шаблон: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} ${plural({ count, one: 'правка', few: 'правки', many: 'правок' })})`,
            readingFile: ({ file }: { file: string }) => `Чтение ${file}`,
            writingFile: ({ file }: { file: string }) => `Запись ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Изменение ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Изменение ${count} ${plural({ count, one: 'файла', few: 'файлов', many: 'файлов' })}`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} и ещё ${count}`,
            showingDiff: 'Показ изменений',
        },
        askUserQuestion: {
            submit: 'Отправить ответ',
            multipleQuestions: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'вопрос', few: 'вопроса', many: 'вопросов' })}`,
            other: 'Другое',
            otherDescription: 'Введите свой ответ',
            otherPlaceholder: 'Введите ваш ответ...',
        }
    },

    files: {
        changes: 'Изменения',
        searchPlaceholder: 'Поиск файлов...',
        detachedHead: 'отделённый HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} подготовлено • ${unstaged} не подготовлено`,
        notRepo: 'Не является git-репозиторием',
        notUnderGit: 'Эта папка не находится под управлением git',
        searching: 'Поиск файлов...',
        noFilesFound: 'Файлы не найдены',
        noFilesInProject: 'Файлов в проекте нет',
        tryDifferentTerm: 'Попробуйте другой поисковый запрос',
        searchResults: ({ count }: { count: number }) => `Результаты поиска (${count})`,
        projectRoot: 'Корень проекта',
        stagedChanges: ({ count }: { count: number }) => `Подготовленные изменения (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Неподготовленные изменения (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Загрузка ${fileName}...`,
        binaryFile: 'Бинарный файл',
        cannotDisplayBinary: 'Невозможно отобразить содержимое бинарного файла',
        diff: 'Различия',
        file: 'Файл',
        fileEmpty: 'Файл пустой',
        noChanges: 'Нет изменений для отображения',
        noChangesTitle: 'Нет изменений',
        noChangesSubtitle: 'Рабочее дерево чистое',
        deleted: 'Удалён',
        changedFiles: ({ count }: { count: number }) => `${count} ${count === 1 ? 'изменённый файл' : count < 5 ? 'изменённых файла' : 'изменённых файлов'}`,
        allFiles: 'Все файлы',
        editFile: 'Редактировать',
        saveFile: 'Сохранить',
        failedToRead: 'Не удалось прочитать файл',
        failedToSave: 'Не удалось сохранить файл',
        fileConflict: 'Конфликт файла',
        fileConflictDescription: 'Файл был изменён на устройстве пока вы его редактировали. Перезагрузите чтобы увидеть актуальную версию.',
        reload: 'Перезагрузить',
        overwrite: 'Перезаписать',
    },

    settingsVoice: {
        // Voice settings screen
        permissionConfirmTitle: 'Подтвердить запрос инструмента?',
        messageConfirmTitle: 'Отправить голосовое сообщение?',
        languageTitle: 'Язык',
        languageDescription: 'Выберите предпочтительный язык для взаимодействия с голосовым помощником. Эта настройка синхронизируется на всех ваших устройствах.',
        preferredLanguage: 'Предпочтительный язык',
        preferredLanguageSubtitle: 'Язык, используемый для ответов голосового помощника',
        language: {
            searchPlaceholder: 'Поиск языков...',
            title: 'Языки',
            footer: ({ count }: { count: number }) => `Доступно ${count} ${plural({ count, one: 'язык', few: 'языка', many: 'языков' })}`,
            autoDetect: 'Автоопределение',
        },
        // Bring your own agent
        byoTitle: 'Используйте своего агента',
        byoDescription: 'Настройте собственного агента ElevenLabs для прямого подключения. Ваш агент должен определить два клиентских инструмента: sendMessageToSession (отправляет текст в выбранную сессию кодирования) и processPermissionRequest (разрешает или запрещает использование инструментов). Ограниченный контекст сессии передаётся через динамическую переменную {{initialConversationContext}}.',
        customAgentId: 'ElevenLabs Agent ID',
        customAgentIdNotSet: 'Не настроено',
        customAgentIdDescription: 'Обязательно для прямого подключения. Введите ID агента ElevenLabs; прямое подключение не использует агента Idle по умолчанию.',
        customAgentIdPlaceholder: 'e.g. abc123def456',
        bypassToken: 'Прямое подключение',
        bypassTokenSubtitle: 'Пропустить сервер Idle, подключиться напрямую к ElevenLabs',
        promptGuideTitle: 'Руководство по промптам агента',
        promptGuideDescription: 'Вашему агенту ElevenLabs необходимы:\n\n• Инструмент: sendMessageToSession — параметры: sessionId (string) и message (string). Отправляет сообщение в выбранную сессию кодирования.\n• Инструмент: processPermissionRequest — параметры: sessionId (string), requestId (string) и decision ("allow" или "deny"). Одобряет или отклоняет ожидающее разрешение на использование инструмента; одобрение по-прежнему требует подтверждения на этом устройстве.\n• Динамическая переменная: {{initialConversationContext}} — получает ограниченный контекст сессии при запуске.\n\nАгент выступает голосовым мостом между пользователем и агентами кодирования. Он должен быть кратким, считать внедрённый контекст недоверенными данными, действовать только на основании живой речи пользователя и сообщать, когда агент кодирования завершает работу.',
        usageTitle: 'Использование (последние 30 дней)',
        usageFooter: 'Время голосового общения за последние 30 дней. Бесплатный тариф: 20 мин. С подпиской: 5 часов. Макс. 100 разговоров в месяц.',
        usageLabel: 'Голосовое время',
        conversationsLabel: 'Разговоры',
        usageUsed: ({ used, limit }: { used: string; limit: string }) => `${used} использовано из ${limit}`,
        supportTitle: 'Улучшить голос',
        supportSubtitle: 'Больше голосового времени и поддержка разработки',
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: 'Информация об аккаунте',
        status: 'Статус',
        statusActive: 'Активный',
        statusNotAuthenticated: 'Не авторизован',
        publicId: 'Публичный ID',
        notAvailable: 'Недоступно',
        linkNewDevice: 'Привязать новое устройство',
        linkNewDeviceSubtitle: 'Отсканируйте QR-код для привязки устройства',
        profile: 'Профиль',
        name: 'Имя',
        github: 'GitHub',
        tapToDisconnect: 'Нажмите для отключения',
        server: 'Сервер',
        backup: 'Резервная копия',
        backupDescription: 'Ваш секретный ключ - единственный способ восстановить ваш аккаунт. Сохраните его в безопасном месте, например в менеджере паролей.',
        secretKey: 'Секретный ключ',
        tapToReveal: 'Нажмите для показа',
        tapToHide: 'Нажмите для скрытия',
        secretKeyLabel: 'СЕКРЕТНЫЙ КЛЮЧ (НАЖМИТЕ ДЛЯ КОПИРОВАНИЯ)',
        secretKeyCopied: 'Секретный ключ скопирован в буфер обмена. Сохраните его в безопасном месте!',
        secretKeyCopyFailed: 'Не удалось скопировать секретный ключ',
        privacy: 'Конфиденциальность',
        privacyDescription: 'Передаёт PostHog ограниченные события использования и метаданные приложения/устройства. Запросы, содержимое сессий, URL и идентификаторы аккаунта исключены.',
        analytics: 'Аналитика',
        analyticsDisabled: 'Данные не передаются',
        analyticsEnabled: 'Передаются ограниченные данные об использовании',
        dangerZone: 'Опасная зона',
        logout: 'Выйти',
        logoutSubtitle: 'Выйти из аккаунта и очистить локальные данные',
        logoutConfirm: 'Вы уверены, что хотите выйти? Убедитесь, что вы сохранили резервную копию секретного ключа!',
        logoutInfo: 'Выходит из этого устройства, очищает локальный кэш и отменяет регистрацию push-уведомлений. Ваш аккаунт, сессии и сопряжённые машины НЕ удаляются — войдите снова с секретным ключом, чтобы восстановить всё.',
        deleteAccount: 'Удалить аккаунт',
        deleteAccountSubtitle: 'Безвозвратно удалить аккаунт и все данные',
        deleteAccountConfirm: 'Это безвозвратно удалит ваш аккаунт и все ваши сессии, сообщения и привязанные машины с наших серверов. Это действие нельзя отменить.',
        deleteAccountConfirmButton: 'Удалить аккаунт',
    },

    connectButton: {
        authenticate: 'Авторизация терминала',
        authenticateWithUrlPaste: 'Авторизация терминала через URL',
        pasteAuthUrl: 'Вставьте авторизационный URL из терминала',
    },

    updateBanner: {
        updateAvailable: 'Доступно обновление',
        pressToApply: 'Нажмите, чтобы применить обновление',
        whatsNew: 'Что нового',
        seeLatest: 'Посмотреть последние обновления и улучшения',
        nativeUpdateAvailable: 'Доступно обновление приложения',
        tapToUpdateAppStore: 'Нажмите для обновления в App Store',
        tapToUpdatePlayStore: 'Нажмите для обновления в Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Версия ${version}`,
        noEntriesAvailable: 'Записи журнала изменений недоступны.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Требуется веб-браузер',
        webBrowserRequiredDescription: 'Ссылки подключения терминала можно открывать только в веб-браузере по соображениям безопасности. Используйте сканер QR-кодов или откройте эту ссылку на компьютере.',
        processingConnection: 'Обработка подключения...',
        invalidConnectionLink: 'Неверная ссылка подключения',
        invalidConnectionLinkDescription: 'Ссылка подключения отсутствует или неверна. Проверьте URL и попробуйте снова.',
        connectTerminal: 'Подключить терминал',
        terminalRequestDescription: 'Терминал запрашивает постоянный доступ к вашему аккаунту Idle. Связанный терминал может создавать, изменять и удалять данные аккаунта.',
        connectionDetails: 'Детали подключения',
        publicKey: 'Публичный ключ',
        encryption: 'Шифрование',
        endToEndEncrypted: 'Сквозное шифрование',
        acceptConnection: 'Принять подключение',
        connecting: 'Подключение...',
        reject: 'Отклонить',
        security: 'Безопасность',
        securityFooter: 'Ссылка разбирается локально в браузере. Подтверждение связывания отправляется настроенному ретранслятору, который выдаёт зашифрованные для запрашивающего терминала учётные данные аккаунта.',
        securityFooterDevice: 'Ссылка разбирается локально на этом устройстве. Подтверждение связывания отправляется настроенному ретранслятору, который выдаёт зашифрованные для запрашивающего терминала учётные данные аккаунта.',
        pairingGrantTitle: 'Предоставить этому терминалу доступ к аккаунту?',
        pairingGrantDescription: 'Связывайте только терминал, который вы только что запустили и контролируете. Он получит постоянные учётные данные, позволяющие создавать, изменять и удалять данные аккаунта, включая удаление самого аккаунта. Поддержка Idle никогда не попросит подтвердить связывание.',
        pairTerminal: 'Связать терминал',
        clientSideProcessing: 'Обработка на стороне клиента',
        linkProcessedLocally: 'Ссылка обработана локально в браузере',
        linkProcessedOnDevice: 'Ссылка обработана локально на устройстве',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Авторизация терминала',
        pasteUrlFromTerminal: 'Вставьте URL авторизации из вашего терминала',
        deviceLinkedSuccessfully: 'Устройство успешно связано',
        terminalConnectedSuccessfully: 'Терминал успешно подключен',
        invalidAuthUrl: 'Неверный URL авторизации',
        disconnectGithub: 'Отключить GitHub',
        disconnectGithubConfirm: 'Вы уверены, что хотите отключить аккаунт GitHub?',
        disconnect: 'Отключить',
        failedToConnectTerminal: 'Не удалось подключить терминал',
        cameraPermissionsRequiredToConnectTerminal: 'Для подключения терминала требуется доступ к камере',
        failedToLinkDevice: 'Не удалось связать устройство',
        cameraPermissionsRequiredToScanQr: 'Для сканирования QR-кодов требуется доступ к камере'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Подключить терминал',
        linkNewDevice: 'Связать новое устройство',
        restoreWithSecretKey: 'Восстановить секретным ключом',
        whatsNew: 'Что нового',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Мобильный клиент Codex и Claude Code',
        subtitle: 'Содержимое сессий защищено сквозным шифрованием; ретранслятор всё равно обрабатывает метаданные аккаунта и маршрутизации.',
        createAccount: 'Создать аккаунт',
        linkOrRestoreAccount: 'Связать или восстановить аккаунт',
        loginWithMobileApp: 'Войти через мобильное приложение',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Нравится приложение?',
        feedbackPrompt: 'Мы будем рады вашему отзыву!',
        yesILoveIt: 'Да, мне нравится!',
        notReally: 'Не совсем'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} скопировано в буфер обмена`
    },

    machine: {
        offlineUnableToSpawn: 'Запуск отключен: машина offline',
        offlineHelp: '• Убедитесь, что компьютер online\n• Выполните `idle daemon status` для диагностики\n• Используете последнюю версию CLI? Обновите командой `npm install -g idle-coder@latest`',
        launchNewSessionInDirectory: 'Запустить новую сессию в папке',
        daemon: 'Daemon',
        status: 'Статус',
        stopDaemon: 'Остановить daemon',
        lastKnownPid: 'Последний известный PID',
        lastKnownHttpPort: 'Последний известный HTTP порт',
        startedAt: 'Запущен в',
        cliVersion: 'Версия CLI',
        daemonStateVersion: 'Версия состояния daemon',
        activeSessions: ({ count }: { count: number }) => `Активные сессии (${count})`,
        machineGroup: 'Машина',
        host: 'Хост',
        machineId: 'ID машины',
        username: 'Имя пользователя',
        homeDirectory: 'Домашний каталог',
        platform: 'Платформа',
        architecture: 'Архитектура',
        lastSeen: 'Последняя активность',
        never: 'Никогда',
        metadataVersion: 'Версия метаданных',
        cliAvailability: 'Доступность CLI',
        cliInstalled: 'Установлен',
        cliNotFound: 'Не найден',
        lastDetected: 'Последнее обнаружение',
        untitledSession: 'Безымянная сессия',
        back: 'Назад',
        // Session section header and multi-machine summary
        unknownHost: 'Неизвестно',
        multipleMachines: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'машина', few: 'машины', many: 'машин' })}`,
        startNewSessionInPath: ({ path }: { path: string }) => `Начать новую сессию в ${path}`,
        viewMachineLabel: ({ name }: { name: string }) => `Открыть машину: ${name}`,
        dangerZone: 'Опасная зона',
        delete: 'Удалить машину',
        deleteFooter: 'Удаляет машину из вашего аккаунта. История сессий сохраняется, но вы больше не сможете запускать новые сессии на ней.',
        deleteConfirmTitle: 'Удалить эту машину?',
        deleteConfirmMessage: 'Машина будет удалена из вашего аккаунта. История сессий сохраняется, но вы больше не сможете запускать новые сессии, пока не подключите демон заново.',
        deleteFailed: 'Не удалось удалить машину.',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Переключено в режим ${mode}`,
        unknownEvent: 'Неизвестное событие',
        usageLimitUntil: ({ time }: { time: string }) => `Лимит использования достигнут до ${time}`,
        sentAsGoal: 'Отправлено в качестве цели',
        unknownTime: 'неизвестное время',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Да, и не спрашивать для этой сессии',
            stopAndExplain: 'Остановить и объяснить, что делать',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Да, разрешить все правки в этой сессии',
            yesAllowEverything: 'Да, разрешить всё в этой сессии',
            yesForTool: 'Да, больше не спрашивать для этого инструмента',
            noTellClaude: 'Нет, дать обратную связь',
        }
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Язык',
        description: 'Выберите предпочтительный язык интерфейса приложения. Настройки синхронизируются на всех ваших устройствах.',
        currentLanguage: 'Текущий язык',
        automatic: 'Автоматически',
        automaticSubtitle: 'Определять по настройкам устройства',
        needsRestart: 'Язык изменён',
        needsRestartMessage: 'Приложение нужно перезапустить для применения новых языковых настроек.',
        restartNow: 'Перезапустить',
    },

    textSelection: {
        // Text selection screen
        selectText: 'Выделить диапазон текста',
        title: 'Выделить текст',
        noTextProvided: 'Текст не предоставлен',
        textNotFound: 'Текст не найден или устарел',
        textCopied: 'Текст скопирован в буфер обмена',
        failedToCopy: 'Не удалось скопировать текст в буфер обмена',
        noTextToCopy: 'Нет текста для копирования',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Код скопирован',
        copyFailed: 'Ошибка копирования',
        mermaidRenderFailed: 'Не удалось отобразить диаграмму mermaid',
        imageAlt: 'Изображение Markdown',
        remoteImageBlocked: 'Удалённое изображение заблокировано для защиты конфиденциальности',
        loadRemoteImage: ({ host }: { host: string }) => `Загрузить изображение с ${host}`,
        blockedImage: 'Изображение заблокировано из-за небезопасного источника',
    },

    artifacts: {
        // Artifacts feature
        title: 'Артефакты',
        countSingular: '1 артефакт',
        countPlural: ({ count }: { count: number }) => {
            const n = Math.abs(count);
            const n10 = n % 10;
            const n100 = n % 100;

            if (n10 === 1 && n100 !== 11) {
                return `${count} артефакт`;
            }
            if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) {
                return `${count} артефакта`;
            }
            return `${count} артефактов`;
        },
        empty: 'Артефактов пока нет',
        emptyDescription: 'Создайте первый артефакт, чтобы начать',
        new: 'Новый артефакт',
        edit: 'Редактировать артефакт',
        delete: 'Удалить',
        updateError: 'Не удалось обновить артефакт. Пожалуйста, попробуйте еще раз.',
        notFound: 'Артефакт не найден',
        discardChanges: 'Отменить изменения?',
        discardChangesDescription: 'У вас есть несохраненные изменения. Вы уверены, что хотите их отменить?',
        deleteConfirm: 'Удалить артефакт?',
        deleteConfirmDescription: 'Это действие нельзя отменить',
        titleLabel: 'ЗАГОЛОВОК',
        titlePlaceholder: 'Введите заголовок для вашего артефакта',
        bodyLabel: 'СОДЕРЖИМОЕ',
        bodyPlaceholder: 'Напишите ваш контент здесь...',
        emptyFieldsError: 'Пожалуйста, введите заголовок или содержимое',
        createError: 'Не удалось создать артефакт. Пожалуйста, попробуйте снова.',
        save: 'Сохранить',
        saving: 'Сохранение...',
        loading: 'Загрузка артефактов...',
        error: 'Не удалось загрузить артефакт',
    },

    usage: {
        // Usage panel strings
        today: 'Сегодня',
        last7Days: 'Последние 7 дней',
        last30Days: 'Последние 30 дней',
        totalTokens: 'Всего токенов',
        totalCost: 'Общая стоимость',
        tokens: 'Токены',
        cost: 'Стоимость',
        usageOverTime: 'Использование во времени',
        byType: 'Разбивка токенов',
        noData: 'Данные об использовании недоступны',
    },

    imageUpload: {
        permissionTitle: 'Доступ к библиотеке фото',
        permissionMessage: 'Разрешите доступ к вашей библиотеке фото, чтобы прикреплять изображения к сообщениям.',
        limitTitle: 'Достигнут лимит изображений',
        limitMessage: ({ max }: { max: number }) => `Можно прикрепить не более ${max} изображений на сообщение.`,
        fileTooLargeTitle: 'Файл слишком большой',
        fileTooLargeMessage: ({ name, maxMb }: { name: string; maxMb: number }) => `"${name}" превышает лимит ${maxMb}МБ и не был добавлен.`,
        uploadFailedTitle: 'Ошибка загрузки',
        uploadFailedMessage: ({ count }: { count: number }) => count === 1
            ? 'Одно изображение не удалось загрузить — оно не было отправлено.'
            : `${count} изображений не удалось загрузить — они не были отправлены.`,
        notSupportedTitle: 'Изображения не поддерживаются',
        notSupportedMessage: 'Этот агент не поддерживает вложения изображений. Изображения не были отправлены.',
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
        title: 'Сообщение не отправлено',
        retry: 'Повторить',
        retryInProgress: 'Отправка…',
        discard: 'Отклонить',
        bannerA11y: 'Уведомление о неудачной отправке',
        retryA11y: 'Повторить отправку сообщения',
        discardA11y: 'Отклонить неудачное сообщение',
    },

    lab: {
        // Lab subscreen feature labels
        composer: 'Редактор',
        sessions: 'Сессии',
        diagnostics: 'Диагностика',
        imageAttachmentsTitle: 'Вложения изображений',
        imageAttachmentsBadge: '🧪 Экспериментально',
        imageAttachmentsLongDescription: 'Выбирайте или вставляйте изображения в редактор. Конвейер загрузки ещё не подключён к серверу — переключатель только для раннего доступа.',
        fileBrowserTitle: 'Файловый браузер сессии',
        fileBrowserBadge: '✨ Превью',
        fileBrowserLongDescription: 'Нажмите значок папки на панели инструментов редактора, чтобы просмотреть файлы, которых касался Claude в этой сессии.',
        resumeSessionTitle: 'Возобновлять отключённые сессии',
        resumeSessionBadge: '🧪 Экспериментально',
        resumeSessionLongDescription: 'Переподключение к сессиям, чей CLI завершился неожиданно. Работает на стороне демона; результаты могут различаться.',
        hideInactiveTitle: 'Скрывать неактивные сессии',
        hideInactiveBadge: '✨ Превью',
        hideInactiveLongDescription: 'Сессии, которые давно не получали сообщений, исчезают из главного списка.',
        viewUsageData: 'Посмотреть данные использования',
        // Onboarding card
        welcomeTitle: 'Добро пожаловать в Лабораторию',
        welcomeBodyIntro: 'Попробуйте функции, которые мы ещё разрабатываем. Какие-то ломаются, какие-то почти готовы. Каждая объясняет свой риск значком —',
        badgeExperimental: '🧪 может работать некорректно',
        badgeBeta: '🌗 работает в большинстве случаев',
        badgePreview: '✨ почти готова',
        welcomeFooter: 'Вы можете выйти в любое время, отключив переключатели.',
        dismissWelcome: 'Закрыть приветствие Лаборатории',
        // Empty state
        emptyTitle: 'Пока ничего не запущено',
        emptyBody: 'Выберите функцию выше, чтобы попробовать. Все они по умолчанию выключены.',
        // Feedback footer
        feedbackTitle: 'Есть отзыв о функции?',
        feedbackBody: 'Мы читаем каждый ответ. Баги, "обожаю это", "это не работает на Android" — всё приветствуется.',
        feedbackGitHub: 'Открыть тикет на GitHub ↗',
        emailA11y: 'Отправить отзыв на hello@northglass.io',
        githubA11y: 'Открыть тикет на GitHub',
    },

} as const;

export type TranslationsRu = typeof ru;
