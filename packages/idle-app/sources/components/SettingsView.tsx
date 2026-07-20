/** Stable navigation integration point for Idle's Settings implementation. */
import * as React from 'react';
import { IdleSettingsView } from './IdleSettingsView';

export const SettingsView = React.memo(function SettingsView() {
    return <IdleSettingsView />;
});
