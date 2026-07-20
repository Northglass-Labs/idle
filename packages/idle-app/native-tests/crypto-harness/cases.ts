import { getRandomBytes } from 'expo-crypto';
import { Platform, TurboModuleRegistry } from 'react-native';

import {
  decryptAESGCM,
  decryptAESGCMString,
  encryptAESGCM,
  encryptAESGCMString,
} from '../../sources/encryption/aes';
import { encodeBase64 } from '../../sources/encryption/base64';
import { AES256Encryption } from '../../sources/sync/encryption/encryptor';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type NativeCryptoCase = {
  name: string;
  run: () => Promise<void>;
};

export type NativeCryptoCaseResult = {
  name: string;
  passed: boolean;
  error?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && jsonEqual(left[key], right[key])
    ))
  );
}

async function expectRejection(operation: Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try {
    await operation;
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

const cases: NativeCryptoCase[] = [
  {
    name: 'iOS Encryption TurboModule is registered',
    run: async () => {
      assert(Platform.OS === 'ios', `Expected iOS, received ${Platform.OS}`);
      const nativeModule = TurboModuleRegistry.get<Record<string, unknown>>('Encryption');
      assert(nativeModule !== null, 'The rn-encryption native module is unavailable');
      assert(typeof nativeModule.encryptAsyncAES === 'function', 'Native async AES is unavailable');
      assert(typeof nativeModule.decryptAsyncAES === 'function', 'Native async AES decryption is unavailable');
    },
  },
  {
    name: 'native AES string round-trip preserves content',
    run: async () => {
      const key = encodeBase64(getRandomBytes(32));
      const plain = JSON.stringify({ text: 'Synthetic message — 世界 🔐', count: 3 });
      const encrypted = await encryptAESGCMString(plain, key);
      assert(encrypted !== plain, 'Ciphertext unexpectedly equals plaintext');
      assert(await decryptAESGCMString(encrypted, key) === plain, 'String round-trip changed content');
    },
  },
  {
    name: 'native AES byte round-trip uses byte equality',
    run: async () => {
      const key = encodeBase64(getRandomBytes(32));
      const plain = new TextEncoder().encode('Byte content — 世界 🔐');
      const encrypted = await encryptAESGCM(plain, key);
      const decrypted = await decryptAESGCM(encrypted, key);
      assert(decrypted instanceof Uint8Array, 'Byte decryption returned null');
      assert(bytesEqual(decrypted, plain), 'Byte round-trip changed content');
    },
  },
  {
    name: 'native AES uses a fresh nonce',
    run: async () => {
      const key = encodeBase64(getRandomBytes(32));
      const first = await encryptAESGCMString('same synthetic plaintext', key);
      const second = await encryptAESGCMString('same synthetic plaintext', key);
      assert(first !== second, 'Repeated encryption reused ciphertext');
      assert(await decryptAESGCMString(first, key) === 'same synthetic plaintext', 'First ciphertext did not decrypt');
      assert(await decryptAESGCMString(second, key) === 'same synthetic plaintext', 'Second ciphertext did not decrypt');
    },
  },
  {
    name: 'native AES rejects the wrong key',
    run: async () => {
      const firstKey = encodeBase64(getRandomBytes(32));
      const secondKey = encodeBase64(getRandomBytes(32));
      const encrypted = await encryptAESGCMString('synthetic secret', firstKey);
      await expectRejection(
        decryptAESGCMString(encrypted, secondKey),
        'Wrong-key decryption unexpectedly succeeded',
      );
    },
  },
  {
    name: 'AES256Encryption preserves JSON value semantics',
    run: async () => {
      const encryptor = new AES256Encryption(getRandomBytes(32));
      const original: JsonValue[] = [
        { id: 'synthetic', nested: { enabled: true, values: [1, 2, null] } },
        ['array', 7, false],
        'Unicode 世界 🔐',
        null,
      ];
      const decrypted = await encryptor.decrypt(await encryptor.encrypt(original));
      assert(
        jsonEqual(decrypted as JsonValue[], original),
        'Encryptor round-trip changed JSON value semantics',
      );
    },
  },
  {
    name: 'AES256Encryption frames ciphertext and uses fresh nonces',
    run: async () => {
      const encryptor = new AES256Encryption(getRandomBytes(32));
      const [first] = await encryptor.encrypt([{ id: 'same' }]);
      const [second] = await encryptor.encrypt([{ id: 'same' }]);
      assert(first[0] === 0 && second[0] === 0, 'AES version marker is missing');
      assert(!bytesEqual(first, second), 'Encryptor reused ciphertext');
      assert(
        jsonEqual((await encryptor.decrypt([first]))[0] as JsonValue, { id: 'same' }),
        'First framed ciphertext did not decrypt',
      );
      assert(
        jsonEqual((await encryptor.decrypt([second]))[0] as JsonValue, { id: 'same' }),
        'Second framed ciphertext did not decrypt',
      );
    },
  },
  {
    name: 'AES256Encryption rejects tampering and unknown versions',
    run: async () => {
      const encryptor = new AES256Encryption(getRandomBytes(32));
      const [encrypted] = await encryptor.encrypt([{ authenticated: true }]);

      const tampered = encrypted.slice();
      tampered[tampered.length - 1] ^= 1;
      const [tamperedResult] = await encryptor.decrypt([tampered]);
      assert(tamperedResult === null, 'Tampered ciphertext unexpectedly decrypted');

      const unknownVersion = encrypted.slice();
      unknownVersion[0] = 1;
      const [versionResult] = await encryptor.decrypt([unknownVersion]);
      assert(versionResult === null, 'Unknown ciphertext version unexpectedly decrypted');
    },
  },
  {
    name: 'AES256Encryption rejects ciphertext under a different key',
    run: async () => {
      const first = new AES256Encryption(getRandomBytes(32));
      const second = new AES256Encryption(getRandomBytes(32));
      const [encrypted] = await first.encrypt([{ synthetic: true }]);
      const [decrypted] = await second.decrypt([encrypted]);
      assert(decrypted === null, 'Wrong-key encryptor decryption unexpectedly succeeded');
    },
  },
  {
    name: 'AES256Encryption preserves empty batches',
    run: async () => {
      const encryptor = new AES256Encryption(getRandomBytes(32));
      assert((await encryptor.encrypt([])).length === 0, 'Empty encryption batch changed length');
      assert((await encryptor.decrypt([])).length === 0, 'Empty decryption batch changed length');
    },
  },
];

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown failure';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 180);
}

export async function runNativeCryptoCases(): Promise<NativeCryptoCaseResult[]> {
  const results: NativeCryptoCaseResult[] = [];
  for (const testCase of cases) {
    try {
      await testCase.run();
      results.push({ name: testCase.name, passed: true });
    } catch (error) {
      results.push({
        name: testCase.name,
        passed: false,
        error: safeErrorMessage(error),
      });
    }
  }
  return results;
}
