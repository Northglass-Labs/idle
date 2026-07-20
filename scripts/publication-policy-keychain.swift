#!/usr/bin/env swift

import CryptoKit
import Foundation
import Security

private let service = "io.northglass.idle.publication-policy"
private let account = "publication-policy-v1"
private let environmentName = "IDLE_PUBLICATION_POLICY_KEY"
private let privatePublicationEnvironment = "private-publication-review"
private let policyAAD = Data("idle-publication-policy/v1".utf8)
private let expectedKeyBytes = 32
private let maxPolicyBytes = 64 * 1024

private enum HelperError: Error {
    case failed
}

private func keychainQuery() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
}

private func loadKey() throws -> Data? {
    var query = keychainQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let key = item as? Data, key.count == expectedKeyBytes else {
        throw HelperError.failed
    }
    return key
}

private func createKey() throws -> Data {
    var key = Data(count: expectedKeyBytes)
    let status = key.withUnsafeMutableBytes { bytes in
        SecRandomCopyBytes(kSecRandomDefault, expectedKeyBytes, bytes.baseAddress!)
    }
    guard status == errSecSuccess else { throw HelperError.failed }

    var item = keychainQuery()
    item[kSecValueData as String] = key
    item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let addStatus = SecItemAdd(item as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
        key.resetBytes(in: 0..<key.count)
        throw HelperError.failed
    }
    return key
}

private func requireKey() throws -> Data {
    if let existing = try loadKey() {
        let attributes = [
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        guard SecItemUpdate(keychainQuery() as CFDictionary, attributes as CFDictionary) == errSecSuccess else {
            throw HelperError.failed
        }
        return existing
    }
    return try createKey()
}

private func encodeHex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

private func install() throws {
    var key = try requireKey()
    key.resetBytes(in: 0..<key.count)
}

private func readBoundedStandardInput() throws -> Data {
    var contents = Data()
    while contents.count <= maxPolicyBytes {
        let remaining = (maxPolicyBytes + 1) - contents.count
        guard remaining > 0 else { break }
        guard let chunk = try FileHandle.standardInput.read(upToCount: min(remaining, 8192)), !chunk.isEmpty else {
            break
        }
        contents.append(chunk)
    }
    guard !contents.isEmpty, contents.count <= maxPolicyBytes else {
        contents.resetBytes(in: 0..<contents.count)
        throw HelperError.failed
    }
    return contents
}

private func minimalEnvironment(additional: [String: String] = [:]) -> [String: String] {
    var environment = [
        "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
        "LANG": "C",
        "LC_ALL": "C",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ]
    for (name, value) in additional {
        environment[name] = value
    }
    return environment
}

private func firstExecutable(_ candidates: [String]) throws -> URL {
    for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
        return URL(fileURLWithPath: candidate)
    }
    throw HelperError.failed
}

private func sealStandardInput() throws {
    var key = try requireKey()
    defer { key.resetBytes(in: 0..<key.count) }
    var plaintext = try readBoundedStandardInput()
    defer { plaintext.resetBytes(in: 0..<plaintext.count) }
    let sealed = try AES.GCM.seal(
        plaintext,
        using: SymmetricKey(data: key),
        authenticating: policyAAD
    )
    guard let combined = sealed.combined else { throw HelperError.failed }
    let envelope: [String: Any] = [
        "version": 1,
        "algorithm": "aes-256-gcm",
        "sealed": combined.base64EncodedString(),
    ]
    let output = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
    FileHandle.standardOutput.write(output)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func runPrivateScanner(node: URL, script: URL, root: URL, key: Data) throws {
    let process = Process()
    process.executableURL = node
    process.arguments = [script.path, "--require-private-policy"]
    process.currentDirectoryURL = root
    var encodedKey = encodeHex(key)
    defer { encodedKey.removeAll(keepingCapacity: false) }
    process.environment = minimalEnvironment(additional: [environmentName: encodedKey])
    try process.run()
    encodedKey.removeAll(keepingCapacity: false)
    process.waitUntilExit()
    guard process.terminationReason == .exit && process.terminationStatus == 0 else {
        throw HelperError.failed
    }
}

private func scanRepository() throws {
    // Key-bearing commands are safe only from trusted main or a reviewed release candidate.
    // Never run this helper from an untrusted pull-request checkout.
    var key = try requireKey()
    defer { key.resetBytes(in: 0..<key.count) }
    let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let scripts = root.appendingPathComponent("scripts", isDirectory: true)
    let opsecScanner = scripts.appendingPathComponent("opsec-boundary.mjs")
    let upstreamScanner = scripts.appendingPathComponent("check-upstream-cruft.mjs")
    guard
        FileManager.default.isReadableFile(atPath: opsecScanner.path),
        FileManager.default.isReadableFile(atPath: upstreamScanner.path)
    else {
        throw HelperError.failed
    }
    let node = try firstExecutable([
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ])
    try runPrivateScanner(node: node, script: opsecScanner, root: root, key: key)
    try runPrivateScanner(node: node, script: upstreamScanner, root: root, key: key)
}

private func setGitHubEnvironmentSecret(key: Data) throws {
    let process = Process()
    process.executableURL = try firstExecutable([
        "/opt/homebrew/bin/gh",
        "/usr/local/bin/gh",
    ])
    process.arguments = [
        "secret", "set", environmentName,
        "--repo", "Northglass-Labs/idle",
        "--env", privatePublicationEnvironment,
    ]
    process.environment = minimalEnvironment()
    let input = Pipe()
    process.standardInput = input
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    var encodedKey = encodeHex(key)
    var keyBytes = Data(encodedKey.utf8)
    defer { keyBytes.resetBytes(in: 0..<keyBytes.count) }
    input.fileHandleForWriting.write(keyBytes)
    keyBytes.resetBytes(in: 0..<keyBytes.count)
    encodedKey.removeAll(keepingCapacity: false)
    try input.fileHandleForWriting.close()
    process.waitUntilExit()
    guard process.terminationReason == .exit && process.terminationStatus == 0 else {
        throw HelperError.failed
    }
}

private func provisionGitHubSecret() throws {
    // This environment-scoped copy is released only after manual approval in
    // the required private PR job. No repository-scoped copy is provisioned.
    var key = try requireKey()
    defer { key.resetBytes(in: 0..<key.count) }
    try setGitHubEnvironmentSecret(key: key)
}

private func main() throws {
    guard CommandLine.arguments.count == 2 else { throw HelperError.failed }
    switch CommandLine.arguments[1] {
    case "install":
        try install()
    case "seal":
        try sealStandardInput()
    case "scan":
        try scanRepository()
    case "provision-github":
        try provisionGitHubSecret()
    default:
        throw HelperError.failed
    }
}

do {
    try main()
} catch {
    FileHandle.standardError.write(Data("publication policy operation failed\n".utf8))
    exit(1)
}
