import * as React from 'react';
import { Redirect } from 'expo-router';

/**
 * Lab replaced /settings/features. This file remains as
 * a redirect for one release cycle so any deep link or cached navigation
 * lands on the new screen.
 */
export default function FeaturesRedirect() {
    return <Redirect href="/settings/lab" />;
}
