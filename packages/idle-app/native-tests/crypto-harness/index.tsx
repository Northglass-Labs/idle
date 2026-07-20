import React, { useEffect, useState } from 'react';
import { registerRootComponent } from 'expo';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NativeCryptoCaseResult, runNativeCryptoCases } from './cases';

type HarnessState =
  | { phase: 'running'; results: NativeCryptoCaseResult[] }
  | { phase: 'complete'; results: NativeCryptoCaseResult[] };

function NativeCryptoHarness() {
  const [state, setState] = useState<HarnessState>({ phase: 'running', results: [] });

  useEffect(() => {
    let active = true;
    void runNativeCryptoCases().then((results) => {
      if (active) {
        setState({ phase: 'complete', results });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const passed = state.results.filter((result) => result.passed).length;
  const failed = state.results.length - passed;
  const complete = state.phase === 'complete';
  const successful = complete && failed === 0 && passed > 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Native crypto harness</Text>
        <Text style={styles.subtitle}>
          Local iOS validation of Idle&apos;s shipping AES bridge and encryptor.
        </Text>

        <View style={[styles.status, successful ? styles.pass : complete ? styles.fail : styles.running]}>
          <Text
            accessibilityRole="summary"
            testID={successful ? 'native-crypto-harness-pass' : complete ? 'native-crypto-harness-fail' : 'native-crypto-harness-running'}
            style={styles.statusText}
          >
            {complete ? `${successful ? 'PASS' : 'FAIL'} ${passed}/${state.results.length}` : 'RUNNING'}
          </Text>
        </View>

        {state.results.map((result) => (
          <View key={result.name} style={styles.row}>
            <Text style={[styles.caseName, result.passed ? styles.passText : styles.failText]}>
              {result.passed ? '✓' : '✗'} {result.name}
            </Text>
            {result.error ? <Text style={styles.error}>{result.error}</Text> : null}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0a0f1a',
  },
  content: {
    padding: 24,
    gap: 12,
  },
  title: {
    color: '#f4f7fb',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#a8b3c7',
    fontSize: 15,
    marginBottom: 8,
  },
  status: {
    borderRadius: 10,
    padding: 16,
    marginBottom: 4,
  },
  running: {
    backgroundColor: '#28344a',
  },
  pass: {
    backgroundColor: '#123d2a',
  },
  fail: {
    backgroundColor: '#4b1f27',
  },
  statusText: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '700',
  },
  row: {
    backgroundColor: '#121a29',
    borderRadius: 8,
    padding: 12,
  },
  caseName: {
    fontSize: 15,
    fontWeight: '600',
  },
  passText: {
    color: '#78d99b',
  },
  failText: {
    color: '#ff8e9e',
  },
  error: {
    color: '#c7cfdd',
    fontSize: 13,
    marginTop: 6,
  },
});

registerRootComponent(NativeCryptoHarness);
